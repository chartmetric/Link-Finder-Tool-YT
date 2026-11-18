"""Saved owner-scope evidence. Association, badges and names alone are not proof."""
import json
import re
import unicodedata
from html.parser import HTMLParser

from instagram_proof_trial import identity
from instagram_trial_v4_sources import explicit_text_links

ROLE = re.compile(
    r"record[\s-]*(?:label|company)|label[\s-]*group|music\s+(?:distribut(?:or|ion)|aggregator)"
    r"|distribuidora|gravadora|sello\s+discogr[aá]fico|лейбл|唱片公司|音楽レーベル|레이블", re.I)
MULTI = re.compile(
    r"\bour\s+(?:(?:artist|label|talent)\s+)?(?:artists|roster|labels)\b|\broster\s+of\s+(?:artists|musicians|talent)\b"
    r"|\bwe\s+(?:represent|distribute|promote)\s+(?:artists|musicians|talent|music)\b"
    r"|\brepresenting\s+(?:multiple|many|a\s+roster\s+of)\s+artists\b"
    r"|\b(?:multi[\s-]*artist|various\s+artists|music\s+aggregator)\b", re.I)
CREATOR = re.compile(
    r"^(?:musician(?:/band)?|artist|band|singer|songwriter|musician/band|"
    r"producer|dj|comedian|actor|writer|music artist)$", re.I)
SELF_ARTIST = re.compile(
    r"(?:^|[.!?\n]\s*)(?:i(?:'m| am)|we(?:'re| are))\s+(?:an?\s+)?"
    r"(?:singer|songwriter|musician|band|artist|dj|producer|comedian|actor)\b"
    r"|\bofficial\s+(?:artist\s+channel|channel\s+of\s+(?:the\s+)?(?:band|artist|singer))\b", re.I)
PUBLISHER_NAME = re.compile(r"\b(?:records|recordings|distribution|distributor|aggregator)\b", re.I)


def name_key(value):
    return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())


class Header(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.description, self.headings = [], [], []
        self.tag, self.skip = None, 0

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        if tag in ("title", "h1"):
            self.tag = tag
        if tag == "meta" and values.get("name", values.get("property", "")).lower() in (
                "description", "og:description"):
            self.description.append(values.get("content", ""))

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1
        if tag == self.tag:
            self.tag = None

    def handle_data(self, data):
        if not self.skip and self.tag == "title":
            self.title.append(data)
        elif not self.skip and self.tag == "h1":
            self.headings.append(data)


def descriptor(packet):
    """Only the captured page owner's fields, never related artists or results."""
    kind, data = packet.get("kind", "website"), packet.get("data") or {}
    category, official = "", False
    if kind == "spotify/artist":
        owner = data.get("profile", {})
        bio = owner.get("biography") or {}
        text = bio.get("text", "") if isinstance(bio, dict) else ""
        links = owner.get("externalLinks", {})
        title = owner.get("name", "")
    elif kind == "instagram/profile":
        owner = data.get("data", {}).get("user") or data.get("user") or {}
        title, text = owner.get("full_name", ""), owner.get("biography", "")
        category = owner.get("category_name") or owner.get("category") or ""
        links = [owner.get("external_url"), owner.get("bio_links", [])]
    elif kind == "tiktok/profile":
        owner = data.get("user", {})
        title, text = owner.get("nickname", ""), owner.get("signature", "")
        links = owner.get("bioLink", {})
    elif kind == "twitter/profile":
        owner = data.get("legacy", {})
        title, text = owner.get("name", ""), owner.get("description", "")
        links = owner.get("entities", {}).get("url", {})
    elif kind == "linktree":
        title = data.get("title") or data.get("username", "")
        text = data.get("description", "")
        links = {k: data.get(k) for k in (
            "links", "spotify", "youtube", "twitter", "instagram", "website")}
    elif kind == "youtube/channel":
        title, text, links = data.get("name", ""), data.get("description", ""), data.get("links", [])
        official = data.get("isOfficialArtistChannel") is True or data.get("isArtist") is True
    elif kind == "soundcloud/artist":
        title = data.get("full_name") or data.get("username", "")
        text, links = data.get("description", ""), data.get("website", "")
    else:
        parser = Header()
        parser.feed(packet.get("body", ""))
        title = " ".join(parser.title)
        text = " ".join(parser.description + parser.headings)
        # Already extracted page links are supplied separately; scripts/nav are
        # not parsed into self-representation statements.
        links = []
    return {
        "kind": kind, "title": str(title or ""), "description": str(text or ""),
        "category": str(category), "official_artist_channel": official,
        "owner_links": explicit_text_links(json.dumps(links, ensure_ascii=False)),
    }


def scope_of_page(packet, normalized, artist):
    d = descriptor(packet)
    title, text, category = d["title"], d["description"], d["category"]
    evidence = {"owner_title": title, "owner_category": category,
                "owner_description_excerpt": text[:800], "basis": []}
    if ROLE.search(title + "\n" + category):
        evidence.update(status="excluded_multi_artist", basis=["PUBLISHER_OWNER_TITLE_OR_CATEGORY"])
        return evidence
    # Credits such as "signed to a record label" are not a statement that the
    # artist page itself is a label. Use self-representation, not arbitrary mentions.
    for match in ROLE.finditer(text):
        prefix = text[max(0, match.start() - 55):match.start()].lower()
        if re.search(r"(?:signed|released|distributed|licensed|managed|supported)\s+(?:\w+\s+){0,3}(?:to|by|via|on|with)\s+", prefix):
            continue
        if match.start() < 240 and (match.start() == 0 or
                re.search(r"(?:^|\n|[.!?]\s+)(?:we\s+are|an?\s+|independent\s+|official\s+|"
                          r".{1,65}\s+is\s+(?:an?\s+)?)$", prefix, re.I)
                or ROLE.search(title)):
            evidence.update(status="excluded_multi_artist", basis=["PUBLISHER_SELF_DESCRIPTION"])
            return evidence
    if MULTI.search(title + "\n" + text):
        evidence.update(status="excluded_multi_artist", basis=["EXPLICIT_MULTI_ARTIST_REPRESENTATION"])
        return evidence
    owner_urls = d["owner_links"]
    if d["kind"] == "website":
        owner_urls = normalized.get("links", [])
    spotify = {i for u in owner_urls if (i := identity(u)) and i[:2] == ("spotify", "artist")}
    if len(spotify) > 1:
        evidence.update(status="excluded_multi_artist", basis=["MULTIPLE_ARTIST_PROFILE_DESTINATIONS"])
        return evidence
    if PUBLISHER_NAME.search(title):
        evidence.update(status="unconfirmed", basis=["PUBLISHER_LIKE_OWNER_NEEDS_CONFIRMATION"])
        return evidence
    known_spotify = {i for a in artist["anchors"] if (i := identity(a["url"]))
                     and i[:2] == ("spotify", "artist")}
    if d["kind"] == "spotify/artist":
        evidence.update(status="artist_specific", basis=["IDENTITY_BOUND_SPOTIFY_ARTIST_ENTITY"])
    elif (CREATOR.fullmatch(category) or d["official_artist_channel"] or SELF_ARTIST.search(text)
          or (name_key(title) == name_key(artist["artist_name"]) and re.search(
              r"\bofficial\s+(?:youtube\s+)?channel\s+(?:of|for)\s+" +
              re.escape(artist["artist_name"]) + r"(?:\b|$)", text, re.I))):
        evidence.update(status="artist_specific", basis=["EXPLICIT_SINGLE_ARTIST_ACCOUNT_SCOPE"])
    elif len(spotify) == 1 and spotify <= known_spotify and (
            d["kind"] not in ("website", "linktree")
            or name_key(title) == name_key(artist["artist_name"])):
        # Exact music identity plus owner-page scope, not a name-only match.
        evidence.update(status="artist_specific", basis=["SINGLE_KNOWN_ARTIST_PROFILE_DESTINATION"])
    else:
        evidence.update(status="unconfirmed", basis=["SINGLE_ARTIST_SCOPE_NOT_ESTABLISHED"])
    return evidence
