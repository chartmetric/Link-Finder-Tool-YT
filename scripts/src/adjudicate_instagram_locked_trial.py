"""Offline, still-blinded correction of unrelated-candidate conflicts.

A rejected search candidate's other Spotify link is not contradictory evidence
about a different, independently supported Instagram. Preserve the full capture,
but reserve manual conflicts for candidates also tied to the target artist.
"""
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from instagram_proof_trial import HUB_HOSTS, digest, identity, instagram_url
from instagram_trial_transport import file_sha, output_paths as collection_output_paths, save_new, utc
from run_instagram_locked_trial import assess

RULES = "instagram-explicit-proof-locked-trial-v3"


def output_paths(root):
    if (root / "retired-to-candidate-completion.json").exists():
        raise ValueError("Parent executor retired; use its candidate-completion results, not provisional outcomes")
    path = root / "adjudicated-output.json"
    if not path.exists():
        return collection_output_paths(root)
    pointer = json.loads(path.read_text())
    if (pointer["results_directory"], pointer["decisions_manifest"], pointer["policy_file"]) != (
            "artist-results-adjudicated", "decisions-adjudicated-frozen.json", "adjudication-policy.json"):
        raise ValueError("Unrecognized adjudicated output paths")
    frozen = root / pointer["decisions_manifest"]
    if file_sha(frozen) != pointer["decisions_sha256"]:
        raise ValueError("Adjudicated frozen decisions changed")
    return frozen, root / pointer["results_directory"], root / pointer["policy_file"]


def assess_without_unrelated_conflicts(artist, anchors, candidates, progress):
    expected = {identity(a["url"]) for a in artist["anchors"]}
    known_spotify = {x for x in expected if x and x[0] == "spotify"}
    allowed = {x for x in expected if x and (x[0] in ("spotify", "youtube")
               or (x[0] == "website" and urlsplit(x[2]).hostname not in HUB_HOSTS
                   and any(a["platform"] in ("website", "official_website")
                           and identity(a["url"]) == x for a in artist["anchors"])))}
    handles = {x[2].casefold() for x in expected if x and x[0] in ("twitter", "tiktok")}
    anchor_targets = {target for r in anchors if r.get("status") == "ok" and r.get("identity_bound")
                      for link in r.get("links", []) if (target := instagram_url(link))}
    relevant, unrelated = [], []
    for candidate in candidates:
        observed = {identity(v) for v in candidate.get("links", [])}
        other_spotify = {x for x in observed if x and x[0] == "spotify"} - known_spotify
        positive_target_evidence = (
            bool(allowed & observed) or candidate["url"] in anchor_targets
            or urlsplit(candidate["url"]).path.strip("/").casefold() in handles)
        if (known_spotify and other_spotify and candidate.get("status") == "ok"
                and candidate.get("identity_bound") and not positive_target_evidence):
            unrelated.append(candidate)
        else:
            relevant.append(candidate)
    decision = assess(artist, anchors, relevant, progress)
    for candidate in unrelated:
        decision["rejected_candidates"].append({
            "url": candidate["url"],
            "reason": "NO_TARGET_ARTIST_PROOF_CANDIDATE_LINKS_TO_OTHER_SPOTIFY",
            "receipt_id": candidate.get("receipt_id"), "identity_rejection": False,
            "note": "Rejected candidate, not conflicting ownership proof for another supported account.",
        })
    # Removing an unrelated candidate from conflict reasoning must not conceal
    # a failed follow-up that could contain further ownership evidence.
    if any(c.get("followups_complete") is not True for c in unrelated):
        if "CANDIDATE_HUB_CHECK_INCOMPLETE" not in decision["reason_codes"]:
            decision["reason_codes"].append("CANDIDATE_HUB_CHECK_INCOMPLETE")
        if decision["state"] in ("VERIFIED", "NOT_FOUND"):
            decision["state"], decision["instagram_url"] = "UNFINISHED", None
    return decision, [c["url"] for c in unrelated]


def adjudicate(root):
    frozen_path, results_path, policy_path = output_paths(root)
    frozen = json.loads(frozen_path.read_text())
    if frozen["halted"] or frozen["rows"] != 200:
        raise ValueError("Do not unblind or revise a still-halted collection")
    inputs = json.loads((root / "inputs.json").read_text())
    policy = json.loads(policy_path.read_text())
    if policy["inputs_sha256"] != file_sha(root / "inputs.json"):
        raise ValueError("Input sample changed")
    for filename, expected in policy["source_code_hashes"].items():
        if file_sha(Path(__file__).parent / filename) != expected:
            raise ValueError("Frozen collection source changed")
    originals = {r["profile_id"]: r for r in inputs}
    out = root / "artist-results-adjudicated"
    out.mkdir()
    changed = []
    for filename, expected_hash in frozen["hashes"].items():
        if not re.fullmatch(r"\d+\.json", filename):
            raise ValueError("Unsafe result filename")
        path = results_path / filename
        if file_sha(path) != expected_hash:
            raise ValueError("Frozen input outcome changed")
        row = json.loads(path.read_text())
        artist = copy.deepcopy(originals[row["profile_id"]])
        if artist["cm_artist"] != row["cm_artist"]:
            raise ValueError("Artist binding changed")
        existing = {a["anchor_id"] for a in artist["anchors"]}
        for anchor in row.get("anchor_checks", []):
            if anchor["anchor_id"] not in existing:
                artist["anchors"].append({
                    "anchor_id": anchor["anchor_id"], "url": anchor["url"],
                    "platform": "owned_hub" if urlsplit(anchor["url"]).hostname in HUB_HOSTS else "owned_website",
                })
        if "progress" in row:
            decision, unrelated = assess_without_unrelated_conflicts(
                artist, row["anchor_checks"], row["candidates_checked"], row["progress"])
            new_row = {**row, **decision}
        else:
            new_row, unrelated = row.copy(), []
        new_row.update(
            rules_version=RULES, decided_at=utc(),
            adjudication={"parent_decision_sha256": expected_hash, "parent_state": row["state"],
                          "unrelated_candidates_not_treated_as_conflicts": unrelated,
                          "no_new_captures_searches_or_model_calls": True},
        )
        if new_row["state"] != row["state"]:
            changed.append({"profile_id": row["profile_id"], "before": row["state"], "after": new_row["state"]})
        save_new(out / filename, new_row)
    final_policy = {**policy, "rules_version": RULES, "adjudicated_at": utc(),
                    "parent_decisions_sha256": file_sha(frozen_path),
                    "parent_policy_sha256": file_sha(policy_path),
                    "adjudication_code_sha256": file_sha(Path(__file__)),
                    "rules_change": "Unrelated rejected candidates alone do not create target-artist ownership conflicts."}
    save_new(root / "adjudication-policy.json", final_policy)
    files = sorted(out.glob("*.json"))
    from collections import Counter
    counts = Counter(json.loads(p.read_text())["state"] for p in files)
    manifest = root / "decisions-adjudicated-frozen.json"
    save_new(manifest, {**{k: v for k, v in frozen.items() if k != "hashes"},
                        "frozen_at": utc(), "hashes": {p.name: file_sha(p) for p in files},
                        "counts": dict(counts), "changed_decisions": changed,
                        "note": "Revised decisions frozen before opening the evaluator-only reference"})
    save_new(root / "adjudicated-output.json", {
        "run_id": frozen["run_id"], "results_directory": out.name,
        "decisions_manifest": manifest.name, "policy_file": "adjudication-policy.json",
        "decisions_sha256": file_sha(manifest)})
    print(json.dumps({"rows": len(files), "counts": dict(counts), "changed": len(changed),
                      "paid_requests": 0, "oracle_unblinded": False}))


if __name__ == "__main__":
    from complete_instagram_trial_candidates import CHILD
    adjudicate(CHILD)
