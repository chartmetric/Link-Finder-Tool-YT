"""Read archived Instagram evidence. No discovery, normalization reruns or network."""

import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path("generated-artifacts/instagram-tier-priority")
CAMPAIGN = "full-tiers-1-5-no-ig-usd100"


def read_json(path):
    return json.loads(Path(path).read_bytes())


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def json_sha(value):
    return sha_bytes(json_text(value).encode())


def handle(url):
    try:
        u = urlsplit(url or "")
        parts = [unquote(p) for p in u.path.split("/") if p]
        if u.hostname in ("instagram.com", "www.instagram.com", "m.instagram.com"):
            if len(parts) == 1 and parts[0].lower() not in ("p", "reel", "reels", "explore"):
                return parts[0].lower()
        if u.hostname == "api.scrapecreators.com":
            return parse_qs(u.query).get("handle", [None])[0]
    except (TypeError, ValueError):
        pass
    return None


def unique(values):
    return list(dict.fromkeys(v for v in values if v is not None and v != ""))


def legacy_indexes(directory):
    """Use recorded admissions to bind legacy captures to artist + exact handle."""
    execution = Path(directory) / "execution"
    models, metadata, models_by_pair = {}, {}, {}
    for path in sorted((execution / "model-responses").glob("*.json")):
        packet = read_json(path)
        key = packet.get("requestBodySha256")
        if key:
            assert key not in models, ("ambiguous historical model request", key)
            models[key] = str(path)
        state = packet.get("decisionRequest", {}).get("state", {})
        context = state.get("catalogAccountEvidence", {})
        if context.get("profileId") and context.get("candidateUrl"):
            identity = (str(context["profileId"]), handle(context["candidateUrl"]))
            assert identity not in models_by_pair, ("ambiguous historical model identity", identity)
            models_by_pair[identity] = str(path)
    admissions = execution / "admissions.jsonl"
    if admissions.exists():
        # JSONL separates records with LF, not Unicode separators inside biographies.
        for line in admissions.read_text().split("\n"):
            if not line.strip():
                continue
            entry = json.loads(line)
            request = entry.get("request", {})
            if request.get("kind") != "scrapecreators_candidate":
                continue
            key = request.get("key") or entry.get("key")
            assert key and "/" not in key and ".." not in key
            path = execution / "metadata-responses" / (key + ".json")
            if path.exists():
                identity = (str(entry["profileId"]), handle(request.get("body", {}).get("url")))
                old = metadata.get(identity)
                assert not old or old == str(path), ("ambiguous legacy capture", identity)
                metadata[identity] = str(path)
    scope = read_json(Path(directory) / "approved-scope.json")
    return {"models": models, "metadata": metadata, "models_by_pair": models_by_pair, "scope": scope}


def resolve_receipts(profile_id, candidate, source, indexes):
    model_path = metadata_path = None
    if source != str(ROOT):
        index = indexes[source]
        model_path = (index["models"].get(candidate.get("requestSha256"))
                      or index.get("models_by_pair", {}).get((profile_id, handle(candidate["url"]))))
        metadata_path = index["metadata"].get((profile_id, handle(candidate["url"])))
    else:
        # Sequential keys hash URL bytes; frozen parallel workers hash JSON(URL).
        # Both use JSON(operationKey) for receipt names. Bind using the original
        # request hash, rather than assuming one worker's filename convention.
        keys = [profile_id + "-" + digest for digest in
                unique([sha_bytes(candidate["url"].encode()), json_sha(candidate["url"])])]
        matches = []
        for possible_key in keys:
            input_path = ROOT / "inputs" / (possible_key + ".json")
            paths = {kind: ROOT / "receipts" / (json_sha(kind + "-" + possible_key) + ".json")
                     for kind in ("metadata", "model")}
            if candidate.get("requestSha256"):
                if not input_path.exists():
                    continue
                saved_input = read_json(input_path)
                if saved_input.get("requestSha256") != candidate["requestSha256"]:
                    continue
            elif not any(path.exists() for path in paths.values()):
                continue
            matches.append((possible_key, paths))
        assert len(matches) <= 1, ("ambiguous original worker request", profile_id)
        if matches:
            key, paths = matches[0]
            metadata_path = str(paths["metadata"]) if paths["metadata"].exists() else None
            model_path = str(paths["model"]) if paths["model"].exists() else None
    model = read_json(model_path) if model_path else None
    metadata = read_json(metadata_path) if metadata_path else None
    request = {}
    if model:
        request = model.get("decisionRequest") or model.get("request", {}).get("body") or {}
        if source == str(ROOT):
            input_path = ROOT / "inputs" / (key + ".json")
            saved_input = read_json(input_path)
            if candidate.get("requestSha256"):
                assert saved_input["requestSha256"] == candidate["requestSha256"]
            assert saved_input["request"] == request, ("original model request differs", profile_id)
            assert model["operationKey"] == "model-" + key
        else:
            if candidate.get("requestSha256"):
                assert model.get("requestBodySha256") == candidate["requestSha256"], ("model input hash binding", profile_id)
        assert model.get("kind", "model") == "model"
        if candidate.get("recordedAnswer"):
            assert model.get("status") == 200
    if metadata:
        requested = metadata.get("requestedUrl") or metadata.get("request", {}).get("url")
        assert handle(requested) == handle(candidate["url"]), ("capture URL binding", profile_id)
        assert metadata.get("kind", "metadata") == "metadata"
    state = request.get("state") or candidate.get("metadataActuallyUsed")
    if state:
        assert any(handle(c.get("url")) == handle(candidate["url"]) for c in state.get("candidates", []))
        context = state.get("catalogAccountEvidence", {})
        if context:
            assert str(context["profileId"]) == profile_id
            assert handle(context["candidateUrl"]) == handle(candidate["url"])
    return model, metadata, request, state, model_path, metadata_path


def capture_fields(packet, candidate, allow_handle_conflict=False):
    normalized = candidate.get("metadata", {})
    profile = normalized.get("candidate") or {}
    data = packet.get("data", {}) if packet else {}
    user = None
    for value in (data.get("data", {}).get("user") if isinstance(data.get("data"), dict) else None,
                  data.get("user"),
                  data.get("data") if isinstance(data.get("data"), dict) else None):
        if isinstance(value, dict) and any(k in value for k in ("username", "full_name", "biography", "id")):
            user = value
            break
    gaps = []
    if packet:
        if packet.get("status") != 200 or data.get("success") is False or packet.get("parseFailed"):
            status, detail = "failed", "saved_http_or_provider_failure"
        elif user:
            status = "ok"
            detail = ("usable_profile_with_provider_error_flag" if data.get("error")
                      else "saved_raw_profile_response")
            if data.get("error"):
                gaps.append("provider_error_flag_despite_success_and_returned_profile")
        elif data.get("error"):
            status, detail = "failed", "saved_provider_error_without_usable_profile"
        else:
            status, detail = "empty", "saved_success_response_without_usable_profile_object"
        evidence_source = "raw_scrapecreators_receipt"
    elif normalized.get("available") is True and profile:
        status, detail = "ok", "normalized_profile_saved_but_raw_receipt_not_found"
        evidence_source = "normalized_scrapecreators_profile_only"
        gaps.append("raw_scrapecreators_receipt_not_found")
    elif normalized:
        status, detail = "failed", normalized.get("reason") or "saved_capture_unavailable_without_raw_receipt"
        evidence_source = "normalized_capture_status_only"
        gaps.append("raw_scrapecreators_receipt_not_found")
    else:
        status, detail = "failed", "no_saved_scrapecreators_capture_record"
        evidence_source = "none"
        gaps.append("no_saved_scrapecreators_capture_record")
    if user and user.get("username"):
        if handle(candidate["url"]) != user["username"].lower():
            assert allow_handle_conflict, ("capture returned a different handle", candidate["url"])
            status, detail = "failed", "provider_returned_different_handle"
            gaps.append("capture_returned_handle=" + user["username"])
    raw_links = []
    bio_links = []
    if user:
        if user.get("external_url"):
            raw_links.append(user["external_url"])
        for item in user.get("bio_links") or []:
            if isinstance(item, dict) and item.get("url"):
                raw_links.append(item["url"])
                bio_links.append(item["url"])
    else:
        raw_links = (profile.get("directExternalUrls") or profile.get("externalUrls") or []) if not packet else []
        # A normalized external URL is not proof that Instagram put it in bio_links.
        bio_links = None
    links = unique(raw_links)
    hubs = {"linktr.ee", "linktree.com", "beacons.ai", "bio.site", "lnk.bio", "solo.to",
            "linkin.bio", "linkfire.com", "ffm.to", "lnk.to", "hoo.be", "allmylinks.com",
            "campsite.bio", "msha.ke", "taplink.cc", "linkr.bio", "linkbio.co", "biglink.to"}
    link_pages = [url for url in links if any((urlsplit(url).hostname or "").removeprefix("www.") == h
                                             or (urlsplit(url).hostname or "").endswith("." + h) for h in hubs)]
    fields = {
        "scrapecreators_full_name": user.get("full_name") if user else profile.get("displayName") if not packet else None,
        "scrapecreators_biography": user.get("biography") if user else profile.get("bio") if not packet else None,
        "scrapecreators_external_urls_json": json_text(links) if user or not packet else None,
        "scrapecreators_bio_link_urls_json": json_text(bio_links) if bio_links is not None else None,
        "scrapecreators_bio_link_page_urls_json": json_text(link_pages),
        "scrapecreators_category": (user.get("category_name") or user.get("business_category_name")
                                   or user.get("overall_category_name")) if user else None,
        "scrapecreators_is_business": user.get("is_business_account") if user else None,
        "scrapecreators_followers": (user.get("edge_followed_by") or {}).get("count") if user else None,
        "capture_status": status, "capture_status_detail": detail,
        "capture_provider_error_flag": bool(data.get("error")),
        "capture_provider_error_code": data.get("error") if isinstance(data.get("error"), str) else None,
        "capture_timestamp": packet.get("at") if packet else None,
        "capture_evidence_source": evidence_source,
        "raw_capture_receipt_available": packet is not None,
        "normalized_capture_available": normalized.get("available") is True,
        "link_capture_status": profile.get("linkCapture", {}).get("status"),
    }
    return fields, gaps


def catalog_fields(state, cm_artist):
    if not state:
        return {"catalog_context_source": "original_model_state_not_found"}
    context = state.get("catalogAccountEvidence", {})
    if context:
        assert str(context["cmArtist"]) == cm_artist, "catalog artist binding"
    accounts = context.get("accounts", [])
    reference_urls = [a.get("url") for a in accounts]
    reference_urls.append(state.get("knownProfileUrl"))
    reference_urls.extend(c.get("reference", {}).get("url") for c in state.get("candidates", []))
    spotify, youtube, tiktok, twitter = [], [], [], []
    for raw in unique(reference_urls):
        u = urlsplit(raw)
        host = (u.hostname or "").removeprefix("www.")
        parts = [p for p in u.path.split("/") if p]
        if host == "open.spotify.com" and len(parts) == 2 and parts[0] == "artist":
            spotify.append(parts[1])
        if host in ("youtube.com", "music.youtube.com", "youtu.be"):
            youtube.append(raw)
        if host == "tiktok.com":
            tiktok.append(raw)
        if host in ("twitter.com", "x.com"):
            twitter.append(raw)
    country = [f.get("value") for f in (state.get("artistContext") or {}).get("catalogFacts", [])
               if f.get("kind") == "country"]
    return {
        "catalog_country": ";".join(unique(country)) or None,
        "catalog_spotify_artist_ids_json": json_text(unique(spotify)),
        "catalog_youtube_urls_json": json_text(unique(youtube)),
        "catalog_tiktok_urls_json": json_text(unique(tiktok)),
        "catalog_twitter_urls_json": json_text(unique(twitter)),
        "catalog_context_source": "original_recorded_model_request",
        "catalog_accounts_used_json": json_text(accounts),
        "catalog_artist_context_used_json": json_text(state.get("artistContext")) if "artistContext" in state else None,
        "catalog_reference_url_used": state.get("knownProfileUrl"),
    }


def other_checked(candidate):
    answer = candidate.get("recordedAnswer", {})
    decision = candidate.get("decision") or candidate.get("review") or {}
    return {
        "url": candidate.get("url"), "status": candidate.get("status"),
        "jev_verdict": answer.get("verdict"),
        "jev_same_identity_probability": answer.get("sameIdentityProbability"),
        "jev_verdict_label_confidence": answer.get("verdictLabelConfidence"),
        "rationale_text": answer.get("rationale") or answer.get("reasoning"),
        "policy_reason": decision.get("reason") or candidate.get("reason"),
        "review_suggestion": candidate.get("reviewSuggestion", decision.get("reviewSuggestion")),
        "rules_version": decision.get("policy"),
        "scrapecreators_capture_available": candidate.get("metadata", {}).get("available"),
        "request_sha256": candidate.get("requestSha256"),
    }


def is_assessed_candidate(candidate):
    """Legacy outcome arrays also contain explicitly uninspected search hits."""
    if candidate.get("status") in ("uninspected", "not_checked", "not_inspected"):
        return False
    if str(candidate.get("reason") or "").startswith(("not_inspected_", "not_checked_")):
        return False
    return bool(candidate.get("metadata") or candidate.get("recordedAnswer")
                or candidate.get("status") or candidate.get("reason"))
