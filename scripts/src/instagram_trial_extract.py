"""Strict source-section adapters; no network or hidden answer-key reads."""
import html
import json
import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

from instagram_proof_trial import HUB_HOSTS, identity, instagram_url, safe_url

URL_RE = re.compile(r"https?://[^\s<>\"'\\\[\]{}]+", re.I)
SOCIAL_DOMAINS = {
    "facebook.com", "instagram.com", "youtube.com", "open.spotify.com", "spotify.com",
    "twitter.com", "x.com", "tiktok.com", "soundcloud.com", "bandcamp.com",
    "wikipedia.org", "en.wikipedia.org", "music.apple.com", "itunes.apple.com",
}


def normalize_link(value):
    if not isinstance(value, str):
        return None
    value = html.unescape(value).strip()
    u = urlsplit(value)
    if (u.hostname or "").lower() in ("l.instagram.com", "www.youtube.com", "youtube.com"):
        if u.hostname == "l.instagram.com" or u.path == "/redirect":
            params = parse_qs(u.query)
            value = (params.get("u") or params.get("q") or [value])[0]
    return safe_url(value)


def text_urls(value):
    return sorted({u for s in URL_RE.findall(html.unescape(value or ""))
                   if (u := normalize_link(s.rstrip(".,;!)")) )})


def exact_list(value, key="url"):
    if not isinstance(value, list):
        raise ValueError("Explicit link list missing")
    result = []
    for x in value:
        v = x if isinstance(x, str) else x.get(key) if isinstance(x, dict) else None
        if v in ("", None):
            # Empty buttons are not external destinations.
            continue
        if not isinstance(v, str):
            raise ValueError("Malformed link entry")
        u = normalize_link(v)
        if u:
            result.append(u)
        elif v.startswith(("http:", "https:")):
            raise ValueError("Unsafe or unsupported external link")
    return result


def sc_profile(kind, requested, packet):
    d = packet.get("data")
    if packet.get("http_status") != 200 or not isinstance(d, dict) or d.get("success") is False:
        raise ValueError("Provider did not return a successful profile")
    expected = identity(requested)
    websites, context = [], []
    if kind == "instagram/profile":
        u = d.get("data", {}).get("user") or d.get("user")
        if not isinstance(u, dict) or not isinstance(u.get("username"), str):
            raise ValueError("Instagram account identity missing")
        returned = instagram_url("https://instagram.com/" + u["username"])
        if returned != instagram_url(requested):
            raise ValueError("Returned Instagram handle differs")
        if "external_url" not in u or "bio_links" not in u or not isinstance(u["bio_links"], list):
            raise ValueError("Incomplete Instagram bio-link fields")
        if u["external_url"] is not None and not isinstance(u["external_url"], str):
            raise ValueError("Malformed external_url")
        links = exact_list(u["bio_links"])
        if u.get("external_url"):
            links += exact_list([u["external_url"]])
        # Plain-text explicit URLs in the actual captured biography are
        # retained; mentions and names are never expanded into URLs.
        links += text_urls(u.get("biography"))
        context = ["data.user.external_url", "data.user.bio_links", "data.user.biography"]
    elif kind == "spotify/artist":
        if d.get("__typename") != "Artist" or d.get("uri") != "spotify:artist:" + expected[2]:
            raise ValueError("Wrong returned Spotify artist")
        if d.get("id") != expected[2]:
            raise ValueError("Spotify ID mismatch")
        p = d.get("profile", {})
        links = exact_list(p.get("externalLinks"))
        context = ["profile.externalLinks"]
        websites = exact_list([x for x in p["externalLinks"]
                               if isinstance(x, dict) and re.fullmatch(
                                   r"(?:official\s+)?website", str(x.get("name", "")), re.I)])
        returned = "https://open.spotify.com/artist/" + d["id"]
    elif kind == "youtube/channel":
        returned = "https://www.youtube.com/channel/" + str(d.get("channelId", ""))
        aliases = {identity(returned), identity(d.get("channel", ""))}
        if expected not in aliases or not identity(returned):
            raise ValueError("Wrong returned YouTube identity")
        links = exact_list(d.get("links"))
        context = ["links"]
        # Structured outbound account links, not recommended channels or video
        # descriptions. Description URLs aren't independently labelled websites.
        links += text_urls(d.get("description"))
    elif kind == "tiktok/profile":
        u = d.get("user")
        if not isinstance(u, dict) or not isinstance(u.get("uniqueId"), str):
            raise ValueError("TikTok identity missing")
        returned = "https://tiktok.com/@" + u["uniqueId"]
        if identity(returned) != expected or "signature" not in u:
            raise ValueError("TikTok identity/context mismatch")
        links = text_urls(u["signature"])
        if isinstance(u.get("bioLink"), dict):
            links += exact_list([u["bioLink"].get("link")])
        context = ["user.signature", "user.bioLink.link"]
    elif kind == "twitter/profile":
        u = d.get("legacy")
        if not isinstance(u, dict) or not isinstance(u.get("screen_name"), str):
            raise ValueError("Twitter identity missing")
        returned = "https://twitter.com/" + u["screen_name"]
        if identity(returned) != expected or not isinstance(u.get("entities"), dict):
            raise ValueError("Twitter identity/context mismatch")
        links = []
        for section in ("description", "url"):
            entry = u["entities"].get(section, {})
            if entry and not isinstance(entry, dict):
                raise ValueError("Malformed Twitter entities")
            links += exact_list(entry.get("urls", []), "expanded_url")
        context = ["legacy.entities.description.urls", "legacy.entities.url.urls"]
    elif kind == "soundcloud/artist":
        returned = d.get("permalink_url")
        if identity(returned) != expected or d.get("kind") != "user" or "description" not in d:
            raise ValueError("SoundCloud identity/context mismatch")
        links = text_urls(d["description"])
        if isinstance(d.get("website"), str):
            links += exact_list([d["website"]])
        context = ["description", "website"]
        # This endpoint does not promise all web-profile social-link fields.
        # A positive explicit edge is usable; absence is not exhaustive.
    elif kind == "linktree":
        name = d.get("username")
        if not isinstance(name, str):
            raise ValueError("Linktree account identity missing")
        returned = "https://linktr.ee/" + name
        if safe_url(returned).casefold() != safe_url(requested).casefold():
            raise ValueError("Linktree identity mismatch")
        links = exact_list(d.get("links"))
        for field in ("instagram", "spotify", "youtube", "tiktok", "twitter", "soundcloud", "website"):
            if d.get(field):
                links += exact_list([d[field]])
        context = ["links", "instagram", "spotify", "youtube", "tiktok", "twitter", "soundcloud", "website"]
    else:
        raise ValueError("Unimplemented profile adapter")
    links = sorted(set(links))
    # Link hubs are artist-owned only when reached through an already trusted
    # anchor, or else are candidate backlinks only, with lineage retained.
    hubs = [u for u in links if urlsplit(u).hostname in HUB_HOSTS]
    return {"returned_url": returned, "links": links, "context_fields": context,
            "website_declarations": websites, "hub_links": hubs,
            "negative_complete": kind != "soundcloud/artist"}


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.visible, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        if tag == "a":
            values = dict(attrs)
            if values.get("href"):
                self.links.append(values["href"])

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.visible.append(data)


def website_links(page):
    body = page["body"]
    if page["status"] != 200 or "html" not in page.get("content_type", ""):
        raise ValueError("Public website unavailable or not HTML")
    parser = PageLinks()
    parser.feed(body)
    visible = " ".join(parser.visible)
    if (len(visible.strip()) < 100 or re.search(
            r"just a moment|verify you are human|checking your browser|access denied|captcha",
            visible[:5000], re.I)):
        raise ValueError("Blocked/unsupported website layout, not an empty page")
    links = sorted({u for x in parser.links if (u := normalize_link(urljoin(page["final_url"], x)))})
    return {"returned_url": page["final_url"], "links": links, "website_declarations": [],
            "hub_links": [u for u in links if urlsplit(u).hostname in HUB_HOSTS],
            "context_fields": ["rendered_artist_website_anchor_hrefs"],
            "negative_complete": True}


def provider_request(url):
    u = urlsplit(safe_url(url) or "")
    ident = identity(url)
    if not ident:
        raise ValueError("Unsupported identity")
    if ident[0] == "spotify":
        return "spotify/artist", {"id": ident[2]}
    if ident[0] == "youtube":
        return "youtube/channel", {"channelId" if ident[1] == "channel" else "handle": ident[2]}
    if ident[0] in ("twitter", "tiktok"):
        return ident[0] + "/profile", {"handle": ident[2]}
    if u.hostname == "soundcloud.com" and len(u.path.strip("/").split("/")) == 1:
        return "soundcloud/artist", {"url": safe_url(url)}
    if u.hostname == "linktr.ee" and len(u.path.strip("/").split("/")) == 1:
        return "linktree", {"url": safe_url(url)}
    return None
