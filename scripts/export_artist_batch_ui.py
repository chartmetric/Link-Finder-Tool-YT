"""Build read-only UI archives from saved results. No providers or database calls."""
import csv
import hashlib
import json
from pathlib import Path
from collections import defaultdict

root = Path("generated-artifacts")
out = root / "artist-batch-ui-data"
out.mkdir(exist_ok=True)

def load_csv(file):
    with file.open(newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))

def group(label):
    low = label.lower()
    if any(s in low for s in ["json", "metadata", "genre", "country", "biograph", "release", "bios", "linked accounts"]):
        return "metadata"
    if any(s in low for s in ["timestamp", "sha256", "source", "archive", "cost", "model", "interpretation", "collected"]):
        return "provenance"
    if any(s in low for s in ["score", "verdict", "status", "outcome", "reason", "error", "explanation", "accepted", "acceptance", "delivery"]):
        return "decision"
    return "identity"

def text(value):
    return "" if value is None else value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def canonical(record, index, batch_id):
    name = record.get("Artist name") or record.get("artist") or ""
    pid = record.get("Profile ID") or record.get("profileId") or ""
    url = record.get("Candidate Instagram link") or record.get("Instagram link") or None
    verified = record.get("Verified Instagram link") or None
    raw_status = record.get("Candidate status", "")
    typ = record.get("Comparison type") or None
    low = raw_status.lower()
    status = "verified" if verified else "control" if typ == "control" else "metadata_failed" if "metadata" in low and ("fail" in low or "unavailable" in low) else "not_inspected" if "not inspected" in low or "not_inspected" in low else "review" if "incomplete" in low else "no_candidate" if not url else "review"
    score = record.get("New same-identity score", record.get("Confidence score", ""))
    score = float(score) if score not in ["", None] else None
    return dict(id=f"{batch_id}:{index}", artistName=name, profileId=str(pid),
                candidateUrl=url, verifiedUrl=verified, status=status, score=score,
                verdict=record.get("New verdict") or record.get("Verdict") or None,
                comparisonType=typ,
                fields=[dict(label=k, value=text(v), group=group(k)) for k, v in record.items()])

documents = []
def document(batch_id, title, source, records, created_at, status, reserved, reported, explanation):
    rows = [canonical(r, i, batch_id) for i, r in enumerate(records)]
    targets = [r for r in rows if r["comparisonType"] != "control"]
    batch = dict(id=batch_id, title=title, source=source, createdAt=created_at, status=status,
                 artistCount=len({r["profileId"] for r in targets}),
                 candidateCount=len({(r["profileId"], r["candidateUrl"]) for r in targets if r["candidateUrl"]}),
                 rowCount=len(rows), verifiedCount=sum(bool(r["verifiedUrl"]) for r in targets),
                 reviewCount=sum(r["status"] == "review" for r in targets),
                 notInspectedCount=sum(r["status"] == "not_inspected" for r in targets),
                 metadataFailedCount=sum(r["status"] == "metadata_failed" for r in targets),
                 noCandidateCount=sum(r["status"] == "no_candidate" for r in targets),
                 reservedUsd=reserved, reportedUsd=reported, explanation=explanation)
    payload = dict(batch=batch, rows=rows)
    (out / f"{batch_id}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    documents.append(batch)

# Preserve every column from the 250-artist findings export, split by the actual
# two source runs rather than calling an interrupted run a completed 250.
latest = load_csv(root / "artist-instagram-findings.csv")
by_archive = defaultdict(list)
for row in latest:
    by_archive[row["Source run archive"]].append(row)
for archive, records in by_archive.items():
    partial = "second" in archive
    summary_file = root / archive / "summary.json"
    summary = json.loads(summary_file.read_text()) if summary_file.exists() else {}
    completed = len({r["Profile ID"] for r in records})
    document("research-second-partial" if partial else "research-third-238",
             f"Research batch 2 · {completed} completed / interrupted" if partial else "Research batch 3 · 238 artists",
             "research", records, summary.get("finishedAt") or "2026-11-09T23:34:00Z",
             "interrupted" if partial else "completed", 1.05 if partial else summary["budget"]["reservedSpendCents"] / 100,
             None, "All saved CSV fields are retained. No catalog links were imported. " +
             ("Only 12 completed results are available from the interrupted 250-artist launch; unfinished/uncertain work is not replayed or represented as completed."
              if partial else "This completed run processed the 238 remaining artists after the interrupted launch."))

def requests_for(directory):
    found = {}
    for file in (directory / "responses").glob("*-jev-*.json"):
        response = json.loads(file.read_text())
        request = response.get("decisionRequest")
        if not request:
            continue
        sha = hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        assert sha == response["requestBodySha256"], file
        for i, candidate in enumerate(request["state"]["candidates"]):
            found[(str(response["profileId"]), candidate["url"])] = (response, i)
    return found

# Earlier source runs: include all discovered URLs, not only the inspected
# profiles in the narrower legacy candidate CSV.
for archive, batch_id, title in [
    ("instagram-bulk-shadow-2026-11-09-approved-50", "research-pilot-50", "Research pilot · 50 artists"),
    ("instagram-bulk-shadow-approved-250-usd20", "research-first-250", "Research batch 1 · 250 artists"),
]:
    directory = root / archive
    manifest = json.loads((directory / "approved-manifest.json").read_text())
    artists = {str(a["profile_id"]): a for a in manifest["artists"]}
    artist_csv = {str(a["profileId"]): a for a in load_csv(directory / "artist-research-results.csv")}
    candidate_csv = {(str(a["profileId"]), a["url"]): a for a in load_csv(directory / "candidate-evidence.csv")}
    overlay_file = directory / "artist-context-evidence.json"
    packets = {str(a["profileId"]): a for a in json.loads(overlay_file.read_text())["packets"]} if overlay_file.exists() else {}
    requests = requests_for(directory)
    records = []
    # JSON permits U+2028/U+2029 inside strings; only physical LF delimits JSONL.
    for line in (directory / "results.jsonl").read_text().split("\n"):
        if not line.strip():
            continue
        result = json.loads(line)
        pid = str(result["profileId"])
        artist = artists[pid]
        raw = result.get("rawResult") or result.get("partialEvidence") or {}
        profiles = {p["url"]: p for p in raw.get("profiles", [])}
        discovered = dict(profiles)
        for attempt in result.get("discoveryAttempts", []):
            for p in attempt.get("profiles", []):
                discovered.setdefault(p["url"], p)
        for url, source_profile in discovered.items() if discovered else [(None, {})]:
            inspected = profiles.get(url, {})
            comparison = inspected.get("identityComparison")
            decision = inspected.get("jevVerification") or {}
            outcome = next((c for c in result.get("candidates", []) if c["url"] == url), {})
            status = ("No saved candidate" if not url else "Candidate — evaluated, not accepted" if decision
                      else "Candidate — metadata failed" if outcome.get("status") == "metadata_failed"
                      else "Candidate — not inspected")
            accepted = url if url and url in result.get("urls", []) else ""
            row = {"Artist name": artist["artist"], "Verified Instagram link": accepted,
                   "Candidate Instagram link": url or "", "Candidate status": status,
                   "Confidence score": decision.get("sameIdentityProbability", ""),
                   "Verdict": decision.get("verdict", ""), "Artist outcome": result.get("status", ""),
                   "Tier": artist.get("tier", ""), "Profile ID": pid,
                   "CM artist": str(artist["cm_artist"]), "Finding or error": outcome.get("reason", result.get("error", ""))}
            row.update({f"Artist CSV / {k}": v for k, v in artist_csv.get(pid, {}).items()})
            row.update({f"Candidate CSV / {k}": v for k, v in candidate_csv.get((pid, url), {}).items()})
            request_entry = requests.get((pid, url))
            if request_entry:
                response, index = request_entry
                state = response["decisionRequest"]["state"]
                context = state.get("artistContext")
                if context and "candidateSignals" in context:
                    context = {**context, "candidateSignals": [context["candidateSignals"][index]]}
                row["Artist context actually sent to checker (JSON)"] = text(context)
                row["Candidate and reference actually sent to checker (JSON)"] = text(state["candidates"][index])
                row["Archived decision request SHA256"] = response["requestBodySha256"]
                row["Metadata delivery status"] = "Context present in saved request" if context else "No supplemental artist context in saved request"
            else:
                row["Metadata delivery status"] = "No archived checker request for this candidate"
            row["Saved artist metadata available (JSON)"] = text(packets.get(pid))
            row["Artist metadata attached to run (JSON)"] = text(artist.get("metadata_context"))
            row["Saved discovery evidence (JSON)"] = text(source_profile)
            row["Saved identity metadata (JSON)"] = text(comparison)
            row["Source run archive"] = archive
            row["Interpretation notes"] = "Available saved metadata may be stale or omitted from the actual request. Not accepted is not proof of a wrong account or an absent link."
            records.append(row)
    completed_ids = {r["Profile ID"] for r in records}
    for pid, artist in artists.items():
        if pid not in completed_ids:
            records.append({"Artist name": artist["artist"], "Profile ID": pid,
                            "CM artist": str(artist["cm_artist"]), "Tier": artist.get("tier", ""),
                            "Candidate Instagram link": "", "Verified Instagram link": "",
                            "Candidate status": "Incomplete — no completed saved result",
                            "Artist outcome": "incomplete",
                            "Finding or error": "No completed result was retained for this selected artist. Provider calls may have been admitted; this is not evidence of no account and does not authorize a retry.",
                            "Artist metadata attached to run (JSON)": text(artist.get("metadata_context")),
                            "Saved artist metadata available (JSON)": text(packets.get(pid)),
                            "Source run archive": archive})
    summary = json.loads((directory / "summary.json").read_text())
    document(batch_id, title, "research", records, summary["finishedAt"], "completed",
             summary["budget"]["reservedSpendCents"] / 100, None,
             "Original saved source run, including every discovered candidate and all legacy CSV columns. Exact archived requests are distinguished from available metadata. No catalog imports.")

diagnostic = root / "saved-verification-fixes-approved-usd1"
report = json.loads((diagnostic / "comparison-report.json").read_text())
document("verification-fixes-20", "Verification comparison · 20 artists + 20 controls",
         "diagnostic", load_csv(diagnostic / "artist-instagram-rerun-findings.csv"),
         json.loads((diagnostic / "summary.json").read_text())["budget"]["sharedBudget"]["observedAt"],
         "completed", 0.80, float(report["provider_reported_cost_usd"]),
         "Saved-evidence verification only. 20 artist candidates and 20 control comparisons reusing one unrelated account; not 20 independent negative accounts. No candidates accepted. Full old/new scores and exact supplied metadata are available below.")
(out / "index.json").write_text(json.dumps(dict(batches=documents, warnings=[]), ensure_ascii=False))
assert sum(d["artistCount"] for d in documents if d["id"] in ["research-second-partial", "research-third-238"]) == 250
for d in documents:
    print(d["id"], d["artistCount"], "artists,", d["rowCount"], "rows")
