"""Deterministic Instagram recheck; no network, model scores, or database writes."""

import html
import json
import re
import unicodedata
from urllib.parse import parse_qsl, unquote, urlsplit

RULES_VERSION = "instagram-saved-exact-links-names-v2"
FILLERS = {"official", "music", "band", "dj", "the", "iam"}
LINK_PAGE_HOSTS = {"linktr.ee", "beacons.ai", "bio.site", "lnk.bio", "solo.to",
                   "hoo.be", "allmylinks.com", "taplink.cc", "linkin.bio"}
URL_PATTERN = re.compile(
    r"(?:https?://|(?:open\.spotify\.com|youtube\.com|music\.youtube\.com|"
    r"twitter\.com|x\.com|tiktok\.com|instagram\.com)/)[^\s<>\"']+", re.I)
MUSIC_CATEGORY = re.compile(
    r"\b(music(?:ian)?s?|band|singer|songwriter|rapper|dj|composer|producer|"
    r"record label|recording|vocalist|guitarist|pianist|drummer|orchestra|"
    r"musico|musica|cantante|musicien|musiker|musisyen)\b|音楽|音乐|音樂|歌手|뮤지션|가수")
# Generic creator/artist labels are not affirmative music evidence, but do not
# by themselves establish a non-music profession.
AMBIGUOUS_CATEGORIES = {"artist", "artista", "artiste", "public figure", "digital creator",
                        "reel creator", "creator", "producer", "arts entertainment"}
GENRES = {
    "rap": r"\b(?:hip hop|hiphop|rap|rapper|trap|drill)\b",
    "rock": r"\b(?:rock|metal|punk|grunge)\b",
    "electronic": r"\b(?:electronic|electronica|techno|house|edm|dubstep|trance|dnb|drum and bass)\b",
    "classical": r"\b(?:classical|opera|orchestral|symphonic)\b",
    "jazz": r"\b(?:jazz|bebop|swing)\b",
    "country": r"\b(?:country music|country singer|country band|bluegrass|americana)\b",
    "reggae": r"\b(?:reggae|dancehall|ska)\b",
    "folk": r"\b(?:folk|folklore)\b",
    "pop": r"\b(?:pop|kpop|k pop|jpop|j pop)\b",
}
LANGUAGES = {
    "turkish": r"\b(?:turkish|turkce|turkisch)\b",
    "spanish": r"\b(?:spanish|espanol|espanola|castellano)\b",
    "english": r"\b(?:english|anglophone)\b",
    "french": r"\b(?:french|francais|francaise|francophone)\b",
    "german": r"\b(?:german|deutsch|deutsche)\b",
    "italian": r"\b(?:italian|italiano|italiana)\b",
    "portuguese": r"\b(?:portuguese|portugues|portuguesa|lusofono)\b",
    "russian": r"\b(?:russian|russkiy)\b",
    "korean": r"\b(?:korean|k pop|kpop)\b",
    "japanese": r"\b(?:japanese|j pop|jpop)\b",
}


def plain(value):
    decomposed = unicodedata.normalize("NFKD", str(value or "").casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def words(value):
    return ["".join(group) for group in re.findall(r"[^\W_]+", plain(value), re.UNICODE)]


def name_tokens(value):
    return [token for token in words(value) if token not in FILLERS]


def normalize_name(value):
    # Never trim digits or transliterate between writing systems.
    return "".join(name_tokens(value))


def name_in_display(artist, display):
    target, source = name_tokens(artist), name_tokens(display)
    if not target:
        return False
    if normalize_name(artist) == normalize_name(display):
        return True
    # Prevent "Ana" from matching "Anastasia"; accept a complete name phrase.
    return any(source[i:i + len(target)] == target for i in range(len(source) - len(target) + 1))


def collection(value):
    if not value:
        return []
    parsed = json.loads(value) if isinstance(value, str) else value
    if not isinstance(parsed, list):
        raise ValueError("Saved collection is not an array")
    return parsed


def urls_in_text(value):
    return [m.group(0).rstrip(".,;!?)）]}>") for m in URL_PATTERN.finditer(html.unescape(str(value or "")))]


def expand_saved_urls(values):
    """Decode explicit redirect targets only; never request/guess a destination."""
    pending = [(str(v), 0) for v in values if isinstance(v, str)]
    found = set()
    while pending:
        raw, depth = pending.pop()
        for url in urls_in_text(raw):
            url = url if "://" in url else "https://" + url
            if url in found:
                continue
            found.add(url)
            if depth < 3:
                pending.extend((v, depth + 1) for _, v in parse_qsl(urlsplit(url).query)
                               if "://" in unquote(v))
    return sorted(found)


def url_identity(raw):
    try:
        url = urlsplit(raw if "://" in str(raw) else "https://" + str(raw))
        host = (url.hostname or "").casefold().removeprefix("www.").removeprefix("m.")
        parts = [unquote(p) for p in url.path.split("/") if p]
    except ValueError:
        return None
    if host == "open.spotify.com" and len(parts) >= 2:
        if parts[0].startswith("intl-"):
            parts = parts[1:]
        if len(parts) == 2 and parts[0] == "artist" and re.fullmatch(r"[A-Za-z0-9]{22}", parts[1]):
            return "spotify", "artist_id", parts[1]
    if host in ("youtube.com", "music.youtube.com") and parts:
        if len(parts) >= 2 and parts[0] == "channel" and re.fullmatch(r"UC[\w-]{22}", parts[1], re.ASCII):
            return "youtube", "channel_id", parts[1]
        if parts[0].startswith("@") and len(parts[0]) > 1:
            return "youtube", "handle", parts[0][1:].casefold()
        if len(parts) >= 2 and parts[0] in ("user", "c"):
            return "youtube", "legacy_path", parts[0] + "/" + parts[1].casefold()
    if host in ("twitter.com", "x.com") and parts:
        if re.fullmatch(r"[A-Za-z0-9_]{1,15}", parts[0]) and parts[0].casefold() not in (
                "home", "intent", "share", "search", "i", "explore", "hashtag"):
            return "twitter", "handle", parts[0].casefold()
    if host == "tiktok.com" and parts and parts[0].startswith("@") and len(parts[0]) > 1:
        return "tiktok", "handle", parts[0][1:].casefold()
    return None


def catalog_identities(row):
    result = set()
    for value in collection(row.get("catalog_spotify_artist_ids_json")):
        if re.fullmatch(r"[A-Za-z0-9]{22}", str(value)):
            result.add(("spotify", "artist_id", str(value)))
    for column in ("catalog_youtube_urls_json", "catalog_tiktok_urls_json", "catalog_twitter_urls_json"):
        result.update(identity for raw in collection(row.get(column))
                      if (identity := url_identity(raw)))
    for account in collection(row.get("catalog_accounts_used_json")):
        identity = url_identity(account.get("url") or account.get("account_url") or "")
        if identity:
            result.add(identity)
        platform = account.get("platform", "").casefold()
        public_handle = account.get("publicHandle")
        if public_handle and platform in ("youtube", "twitter", "tiktok"):
            result.add((platform, "handle", public_handle.lstrip("@").casefold()))
    return result


def genre_labels(value):
    text = " ".join(words(value))
    return {label for label, pattern in GENRES.items() if re.search(pattern, text)}


def language_labels(value, require_music=False):
    text = " ".join(words(value))
    # Do not mistake the writing language or a nationality/country for the
    # artist's musical language. Require an explicit adjacent music declaration.
    result = set()
    for label, pattern in LANGUAGES.items():
        for match in re.finditer(pattern, text):
            nearby = text[max(0, match.start() - 25):match.end() + 30]
            if not require_music or re.search(
                    r"\b(rap|rock|pop|music|band|singer|songs|singing|hip hop|lyrics)\b", nearby):
                result.add(label)
    return result


def promoted_releases(bio):
    text = str(bio or "")
    # Only explicit release announcements with a delimited title. Do not turn
    # every capitalized phrase or common "out now" into a release claim.
    patterns = [
        r"\b(?:new\s+)?(?:single|album|ep|track|song|release)\s*[:\-]?\s*['\"“‘«]([^'\"”’»\n]{2,100})['\"”’»]",
        r"['\"“‘«]([^'\"”’»\n]{2,100})['\"”’»]\s*(?:[-—–:]\s*)?(?:is\s+)?(?:out now|available now|out everywhere)",
        r"\b(?:new\s+)?(?:single|album|ep|track|song|release)\s*[:\-]?\s+"
        r"(?!['\"“‘«])([^\n]{2,100}?)\s+(?:is\s+)?(?:out now|available now|out everywhere)",
    ]
    return sorted({m.group(1).strip() for pattern in patterns
                   for m in re.finditer(pattern, text, re.I)})


def member_account_conflict(bio, selected_handle):
    text = str(bio or "")
    # Both a first-person member/personal cue and a distinct explicitly
    # official/group target are required; "members: @..." on a band is not it.
    pattern = (
        r"(?:\b(?:member|vocalist|guitarist|drummer|bassist|singer)\s+(?:of|at|for)\s+"
        r"(?:the\s+)?(?:band\s+)?@([A-Za-z0-9_.]+))|"
        r"(?:\b(?:my\s+)?(?:personal|private)\s+(?:account|page)\b[^\n]{0,120}?"
        r"(?:official|band|group)\s*(?:account|page)?\s*[:\-]?\s*@([A-Za-z0-9_.]+))"
    )
    return sorted({handle.rstrip(".").casefold() for match in re.finditer(pattern, text, re.I)
                   for handle in match.groups() if handle and handle.rstrip(".").casefold() != selected_handle})


def recheck(row, context=None):
    context = context or {}
    artist = row["artist_name"]
    display = row.get("scrapecreators_full_name") or ""
    bio = row.get("scrapecreators_biography") or ""
    ig_handle = row["selected_handle"].lstrip("@").casefold()
    normalized_artist = normalize_name(artist)
    normalized_display = normalize_name(display)
    normalized_handle = normalize_name(ig_handle)
    keep, review, gaps = [], [], []
    checks = {}
    expected = catalog_identities(row)
    values = [bio]
    for key in ("scrapecreators_external_urls_json", "scrapecreators_bio_link_urls_json"):
        values.extend(collection(row.get(key)))
    # Optional pages must be previously captured, explicitly account-bound
    # payloads. A bare link-page URL/slug is never treated as page contents.
    values.extend(context.get("bound_saved_link_page_texts", []))
    observed_urls = expand_saved_urls(values)
    observed = {identity for raw in observed_urls if (identity := url_identity(raw))}
    for artist_id in re.findall(r"spotify:artist:([A-Za-z0-9]{22})(?![A-Za-z0-9])", bio):
        observed.add(("spotify", "artist_id", artist_id))
    matched = expected & observed
    expected_spotify = {i for i in expected if i[0] == "spotify"}
    observed_spotify = {i for i in observed if i[0] == "spotify"}
    expected_social = {i for i in expected if i[0] in ("youtube", "twitter", "tiktok")}
    handle_matches = {i for i in expected_social if i[1] == "handle" and i[2] == ig_handle}
    if any(i[0] == "spotify" for i in matched):
        keep.append("EXACT_CATALOG_SPOTIFY_LINK")
    if any(i[0] == "youtube" for i in matched):
        keep.append("EXACT_CATALOG_YOUTUBE_CHANNEL")
    if handle_matches:
        keep.append("EXACT_CATALOG_SOCIAL_HANDLE")
    if normalized_artist and normalized_display == normalized_artist:
        keep.append("EXACT_NORMALIZED_DISPLAY_NAME")
    elif normalized_artist and normalized_handle == normalized_artist and name_in_display(artist, display):
        keep.append("EXACT_NORMALIZED_HANDLE_WITH_DISPLAY_NAME")
    if row.get("capture_status") != "ok":
        review.append("CAPTURE_NOT_USABLE")
    if context.get("catalog_binding") not in (None, "matched"):
        review.append("CATALOG_IDENTITY_BINDING_UNAVAILABLE_OR_CHANGED")
    if observed_spotify and expected_spotify:
        wrong_spotify = observed_spotify - expected_spotify
        if wrong_spotify:
            review.append("CONFLICT_DIFFERENT_SPOTIFY_ARTIST")
        checks["spotify_conflict"] = "conflict" if wrong_spotify else "no_conflict_observed"
    elif observed_spotify:
        review.append("REVIEW_SPOTIFY_ID_WITHOUT_CATALOG_REFERENCE")
        gaps.append("catalog_spotify_id_unavailable")
        checks["spotify_conflict"] = "unknown"
    else:
        checks["spotify_conflict"] = "no_artist_id_observed"
    if expected_social and not (handle_matches or expected_social & observed):
        review.append("CONFLICT_NO_CATALOG_SOCIAL_MATCH_IN_SAVED_CAPTURE")
    checks["other_socials"] = (
        "no_conflict_observed" if handle_matches or expected_social & observed
        else "no_match_observed" if expected_social else "no_catalog_socials_recorded")
    category = plain(row.get("scrapecreators_category")).strip()
    category_words = " ".join(words(category))
    if category and not MUSIC_CATEGORY.search(category_words) and category_words not in AMBIGUOUS_CATEGORIES:
        review.append("CONFLICT_NON_MUSIC_CATEGORY")
    checks["category"] = "not_saved" if not category else (
        "music_or_generic_artist" if "CONFLICT_NON_MUSIC_CATEGORY" not in review else "non_music")
    member_targets = member_account_conflict(bio, ig_handle)
    if member_targets:
        review.append("CONFLICT_MEMBER_OR_PERSONAL_ACCOUNT")
    checks["member_account"] = "conflict" if member_targets else "no_explicit_conflict_observed"
    releases = promoted_releases(bio)
    catalog_titles = context.get("track_titles", []) + context.get("album_titles", [])
    # Keep all words/digits for song titles; artist-name fillers do not apply.
    title_key = lambda value: "".join(words(value))
    available_titles = {title_key(t) for t in catalog_titles if title_key(t)}
    missing_releases = [t for t in releases if title_key(t) not in available_titles]
    if missing_releases:
        review.append("REVIEW_PROMOTED_RELEASE_NOT_IN_SAVED_CATALOG")
    checks["promoted_release"] = ("not_declared_explicitly" if not releases else
                                  "matched_saved_title" if not missing_releases else
                                  "not_found_in_partial_catalog" if available_titles else "catalog_unavailable")
    if not context.get("track_catalog_complete", False):
        gaps.append("release_catalog_partial_or_unavailable_absence_is_not_disproof")
    genres = context.get("genres", [])
    catalog_genres = genre_labels(" ".join(genres))
    bio_genres = genre_labels(bio)
    catalog_languages = language_labels(" ".join(genres))
    bio_languages = language_labels(bio, require_music=True)
    if bio_genres and catalog_genres and not bio_genres & catalog_genres:
        review.append("CONFLICT_EXPLICIT_GENRE_CLASH")
    elif bio_genres and not catalog_genres:
        review.append("REVIEW_CATALOG_GENRE_UNAVAILABLE")
    if bio_languages and catalog_languages and not bio_languages & catalog_languages:
        review.append("CONFLICT_EXPLICIT_MUSIC_LANGUAGE_CLASH")
    elif bio_languages and not catalog_languages:
        review.append("REVIEW_CATALOG_MUSIC_LANGUAGE_UNAVAILABLE")
    checks["genre"] = ("not_explicit_in_bio" if not bio_genres else
                       "catalog_unavailable" if not catalog_genres else
                       "conflict" if "CONFLICT_EXPLICIT_GENRE_CLASH" in review else "overlap")
    checks["language"] = ("not_explicit_in_bio" if not bio_languages else
                          "catalog_unavailable" if not catalog_languages else
                          "conflict" if "CONFLICT_EXPLICIT_MUSIC_LANGUAGE_CLASH" in review else "overlap")
    if not catalog_genres:
        gaps.append("catalog_genre_unavailable")
    if not catalog_languages:
        gaps.append("catalog_musical_language_unavailable")
    # Do not call a model to guess absent catalog facts; keep unknown checks
    # explicit. Deterministic comparisons only cover explicit declarations.
    link_pages = collection(row.get("scrapecreators_bio_link_page_urls_json"))
    if link_pages and not context.get("bound_saved_link_page_texts"):
        gaps.append("link_page_url_saved_without_page_contents")
    if not keep:
        review.append("NO_REQUIRED_POSITIVE_MATCH")
    decision = "review" if review else "keep"
    return {
        "decision": decision,
        "reason_codes": sorted(set(review if review else keep)),
        "qualifying_match_codes": sorted(set(keep)),
        "check_statuses": checks,
        "data_gaps": sorted(set(gaps)),
        "normalized_artist_name": normalized_artist,
        "normalized_display_name": normalized_display,
        "normalized_handle_name": normalized_handle,
        "evidence": {
            "catalog_identities": sorted(expected), "observed_url_identities": sorted(observed),
            "observed_urls": observed_urls, "matched_identities": sorted(matched),
            "exact_catalog_handle_matches": sorted(handle_matches),
            "member_official_targets": member_targets, "promoted_release_titles": releases,
            "unmatched_promoted_release_titles": missing_releases,
            "saved_catalog_genres": genres, "bio_genre_families": sorted(bio_genres),
            "catalog_genre_families": sorted(catalog_genres),
            "bio_music_languages": sorted(bio_languages),
            "catalog_music_languages": sorted(catalog_languages),
            "jev_probability_used": False,
        },
    }
