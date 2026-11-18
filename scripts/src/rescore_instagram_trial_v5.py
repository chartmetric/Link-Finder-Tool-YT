"""Offline replay of BOTH frozen trials. No provider, model or database calls."""
import copy
import csv
import json
from collections import defaultdict
from pathlib import Path
from shutil import copyfile
from unittest.mock import patch
from urllib.parse import urlsplit
from uuid import uuid4

from instagram_proof_trial import identity, instagram_url
from instagram_trial_extract import SOCIAL_DOMAINS, provider_request
from instagram_trial_transport import file_sha, save_new, utc
from instagram_trial_v4_sources import is_hub, profile_links
from instagram_trial_v5_rules import RULES, assess
from instagram_trial_v5_scope import scope_of_page
from rescore_instagram_trial_v4 import OLD, ROOT as PREVIOUS, SavedEvidence, metrics

ROOT = Path("generated-artifacts/instagram-single-artist-v5-2026-11-18-final")


def annotate(evidence, source, artist, candidate=False):
    try:
        result = evidence.candidate(source) if candidate else evidence.page(source)
        request = ("instagram/profile", {"handle": source["url"].rstrip("/").split("/")[-1]}) \
            if candidate else provider_request(source["url"])
        packet, _, _ = evidence.packet(result, source["url"],
                                       request[0] if request else None, request[1] if request else None)
        result["ownership_scope"] = scope_of_page(packet, result, artist)
        if candidate:
            direct = profile_links("instagram/profile", source["url"], packet)
            result["direct_links"] = direct["links"]
            result["direct_hub_links"] = direct["hub_links"]
            result["hub_checks"] = [annotate(evidence, h, artist) for h in result["hub_checks"]]
        return result
    except (ValueError, OSError, KeyError, TypeError) as error:
        return {**source, "status": "failed", "identity_bound": False,
                "ownership_scope": {"status": "unconfirmed", "basis": ["SAVED_CAPTURE_UNAVAILABLE_OR_UNBOUND"]},
                "v5_replay_error": str(error)}


def run():
    ROOT.mkdir()
    (ROOT / "source-snapshots").mkdir()
    for name in ("rescore_instagram_trial_v5.py", "instagram_trial_v5_scope.py",
                 "instagram_trial_v5_rules.py", "instagram_trial_v4_rules.py",
                 "instagram_trial_v4_sources.py", "rescore_instagram_trial_v4.py"):
        copyfile(Path("scripts/src") / name, ROOT / "source-snapshots" / name)
    run_id = str(uuid4())
    save_new(ROOT / "RUN.json", {
        "run_id": run_id, "rules_version": RULES, "created_at": utc(),
        "new_paid_calls": 0, "full_run_authorized": False,
        "existing_tables_mutable": False, "evaluation_kind": "UNBLINDED_SAVED_EVIDENCE_REPLAY",
    })
    datasets = {
        "first": (OLD, PREVIOUS / "saved-evidence-rescore" / "rescored-all-200-audit.jsonl"),
        "fresh": (PREVIOUS / "fresh-trial", PREVIOUS / "fresh-trial" / "fresh-all-200-audit.jsonl"),
    }
    prepared, bindings, original_hashes = {}, defaultdict(set), {}
    for phase, (source, path) in datasets.items():
        original_hashes[phase] = {
            "audit_sha256": file_sha(path), "admissions_sha256": file_sha(source / "admissions.jsonl"),
            "inputs_sha256": file_sha(source / "inputs.json"),
        }
        inputs = {r["profile_id"]: r for r in json.loads((source / "inputs.json").read_text())}
        evidence = SavedEvidence(source)
        prepared[phase] = []
        for row in map(json.loads, path.open()):
            artist = copy.deepcopy(inputs[row["profile_id"]])
            anchors = [annotate(evidence, a, artist) for a in row["anchor_checks"]]
            candidates = [annotate(evidence, c, artist, True) for c in row["candidates_checked"]]
            for seed in artist["anchors"]:
                if not seed["anchor_id"].startswith(("followup:", "candidate-hub:")):
                    bindings[identity(seed["url"])].add(artist["cm_artist"])
            prepared[phase].append((row, artist, anchors, candidates))
    # A catalog account shared by different artist entities is not affirmative
    # single-artist proof. It may be an alias; do not silently assume that.
    shared = {i for i, owners in bindings.items() if i and len(owners) > 1}
    excluded, publisher_hosts = set(shared), set()
    for rows in prepared.values():
        for _, _, anchors, candidates in rows:
            for page in anchors + candidates + [h for c in candidates for h in c.get("hub_checks", [])]:
                scope = page.get("ownership_scope", {})
                if scope.get("status") == "excluded_multi_artist":
                    excluded.update(i for u in (page["url"], page.get("returned_url")) if (i := identity(u)))
                if (scope.get("status") == "excluded_multi_artist"
                        or "PUBLISHER_LIKE_OWNER_NEEDS_CONFIRMATION" in scope.get("basis", [])):
                    host = urlsplit(page["url"]).hostname
                    if (not provider_request(page["url"]) and not is_hub(page["url"])
                            and host not in SOCIAL_DOMAINS
                            and not any(host == h or host.endswith("." + h) for h in (
                                "youtube.com", "spotify.com", "instagram.com", "tiktok.com",
                                "twitter.com", "x.com", "soundcloud.com", "bandcamp.com"))):
                        publisher_hosts.add(host)
    save_new(ROOT / "SOURCE-POLICY.json", {
        "rules_version": RULES, "source_hashes": original_hashes,
        "code_sha256": {p.name: file_sha(p) for p in [
            Path(__file__), Path("scripts/src/instagram_trial_v5_scope.py"),
            Path("scripts/src/instagram_trial_v5_rules.py")]},
        "shared_catalog_identity_count": len(shared), "excluded_identity_count": len(excluded),
        "publisher_website_hosts": sorted(publisher_hosts), "new_paid_calls": 0,
        "unknown_source_scope_is_not_ownership_proof": True,
    })
    results = {}
    for phase, rows in prepared.items():
        updated = []
        for prior, artist, anchors, candidates in rows:
            progress = copy.deepcopy(prior["progress"])
            decision = assess(artist, anchors, candidates, progress, excluded, publisher_hosts)
            updated.append({
                **prior, **decision, "run_id": run_id, "source_trial_run_id": prior["run_id"],
                "phase": phase, "rules_version": RULES, "decided_at": utc(),
                "before_state": prior["state"], "before_instagram_url": prior["instagram_url"],
                "before_proof": prior["proof"], "anchor_checks": anchors,
                "catalog_context": artist, "new_paid_calls": 0,
                "evaluation_kind": "UNBLINDED_SAVED_EVIDENCE_REPLAY",
                "production_port_authorized": False,
            })
        with (ROOT / (phase + "-all-200-audit.jsonl")).open("x") as stream:
            for row in updated:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        fields = ["profile_id", "cm_artist", "artist_name", "tier", "group", "before_state",
                  "state", "before_instagram_url", "instagram_url", "rules_version"]
        with (ROOT / (phase + "-all-200.csv")).open("x", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields + ["proof", "unfinished_checks", "ownership_exclusions"])
            writer.writeheader()
            for row in updated:
                writer.writerow({**{k: row.get(k) for k in fields}, **{
                    k: json.dumps(row.get(k, []), ensure_ascii=False)
                    for k in ("proof", "unfinished_checks", "ownership_exclusions")}})
        results[phase] = updated
    # Freeze all new predictions before comparing to the already-unblinded key.
    save_new(ROOT / "DECISIONS-FROZEN.json", {
        "run_id": run_id, "at": utc(), "rows": 400,
        "files": {phase: file_sha(ROOT / (phase + "-all-200-audit.jsonl")) for phase in results}})
    report = {"run_id": run_id, "rules_version": RULES, "new_paid_calls": 0,
              "full_run_authorized": False, "evaluation_kind": "UNBLINDED_REPLAY_NOT_A_NEW_TEST", "trials": {}}
    for phase, (source, path) in datasets.items():
        reference = json.loads((source / "oracle.evaluator-only.json").read_text())
        oracle = {r["profile_id"]: {instagram_url(u) for u in r["accepted_urls"]}
                  for r in reference["controls"]}
        prior = [r[0] for r in prepared[phase]]
        report["trials"][phase] = {
            "before": metrics(prior, oracle), "after": metrics(results[phase], oracle),
            "changed_states": sum(a["state"] != b["state"] for a, b in zip(prior, results[phase])),
            "changed_selections": sum(a["instagram_url"] != b["instagram_url"] for a, b in zip(prior, results[phase])),
        }
        if file_sha(source / "admissions.jsonl") != original_hashes[phase]["admissions_sha256"]:
            raise ValueError("Historical admissions changed")
        if file_sha(path) != original_hashes[phase]["audit_sha256"]:
            raise ValueError("Historical results changed")
    save_new(ROOT / "COMPARISON.json", report)
    print(json.dumps(report))


if __name__ == "__main__":
    # Fail loudly on accidental networking, including any transitive helper.
    with patch("socket.socket", side_effect=AssertionError("OFFLINE_REPLAY_NETWORK_FORBIDDEN")), \
            patch("socket.getaddrinfo", side_effect=AssertionError("OFFLINE_REPLAY_DNS_FORBIDDEN")):
        run()
