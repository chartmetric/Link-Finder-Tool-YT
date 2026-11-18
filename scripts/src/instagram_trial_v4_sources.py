"""Additional explicit ownership links; never expand unlabelled names/mentions.

The old trial adapters remain immutable so their frozen source hashes and
historical outputs stay reproducible.
"""
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

from instagram_proof_trial import HUB_HOSTS, identity, instagram_url, safe_url
from instagram_trial_extract import SOCIAL_DOMAINS, normalize_link, sc_profile, text_urls

HUBS = HUB_HOSTS | {"link.me", "linkin.bio", "bio.link", "ffm.to"}
LABELLED_INSTAGRAM = re.compile(
    r"(?im)^[ \t]*(?:(?:follow|find)\s+(?:me|us)\s+(?:on\s+)?)?"
    r"(?:instagram|insta|ig)[ \t]*[:：=–-][ \t]*@?"
    r"([a-z0-9_][a-z0-9_.]{0,29})(?=$|[ \t\r\n,;!])"
)


def is_hub(url):
    host = urlsplit(safe_url(url) or "").hostname or ""
    return host in HUBS or host.endswith((".lnk.to", ".ffm.to"))


def explicit_text_links(text):
    """Profile text URLs, HTML hrefs and explicit 'Instagram: @account' labels."""
    if not isinstance(text, str):
        return []
    links = set(text_urls(text))
    for value in re.findall(r"(?i)(?<![\w@./])www\.[^\s<>\"']+", text):
        if link := normalize_link("https://" + value.rstrip(".,;!)")):
            links.add(link)
    for value in re.findall(r"spotify:artist:[A-Za-z0-9]{22}(?![A-Za-z0-9])", text):
        links.add("https://open.spotify.com/artist/" + value.split(":")[-1])
    for match in LABELLED_INSTAGRAM.finditer(text):
        if link := instagram_url("https://instagram.com/" + match[1]):
            links.add(link)

    class Hrefs(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag == "a":
                value = dict(attrs).get("href", "")
                if identity(value) and value.startswith("spotify:artist:"):
                    links.add("https://open.spotify.com/artist/" + value.split(":")[-1])
                elif link := normalize_link(value):
                    links.add(link)

    parser = Hrefs(convert_charrefs=True)
    parser.feed(text)
    return sorted(links)


def declared_site(url):
    """An exact declared destination, not a shared platform homepage."""
    url = normalize_link(url) if isinstance(url, str) else None
    if not url:
        return None
    parsed = urlsplit(url)
    if is_hub(url):
        return url if parsed.path.strip("/") else None
    if parsed.hostname in SOCIAL_DOMAINS or parsed.hostname in (
        "youtu.be", "m.youtube.com", "m.tiktok.com", "l.instagram.com",
    ):
        return None
    return url


def profile_links(kind, requested, packet):
    extracted = sc_profile(kind, requested, packet)
    data = packet["data"]
    texts, sites = [], list(extracted["website_declarations"])
    if kind == "spotify/artist":
        biography = data.get("profile", {}).get("biography")
        texts.append(("profile.biography.text", biography.get("text") if isinstance(biography, dict) else None))
    elif kind == "youtube/channel":
        texts.append(("description", data.get("description")))
    elif kind == "instagram/profile":
        user = data.get("data", {}).get("user") or data.get("user")
        texts.append(("data.user.biography", user.get("biography")))
    elif kind == "tiktok/profile":
        user = data["user"]
        texts.append(("user.signature", user.get("signature")))
        bio = user.get("bioLink")
        value = bio.get("link") if isinstance(bio, dict) else None
        if site := declared_site(value):
            sites.append(site)
    elif kind == "twitter/profile":
        user = data["legacy"]
        texts.append(("legacy.description", user.get("description")))
        for entry in user.get("entities", {}).get("url", {}).get("urls", []):
            if isinstance(entry, dict) and (site := declared_site(entry.get("expanded_url"))):
                sites.append(site)
    elif kind == "soundcloud/artist":
        texts.append(("description", data.get("description")))
        if site := declared_site(data.get("website")):
            sites.append(site)
    additions = []
    for field, text in texts:
        for link in explicit_text_links(text):
            additions.append({"url": link, "field": field})
    extracted["links"] = sorted(set(extracted["links"]) | {x["url"] for x in additions})
    extracted["context_fields"] = sorted(set(extracted["context_fields"]) | {
        x["field"] for x in additions})
    extracted["explicit_text_link_records"] = additions
    extracted["website_declarations"] = sorted(set(sites))
    extracted["hub_links"] = [u for u in extracted["links"] if is_hub(u)]
    return extracted
