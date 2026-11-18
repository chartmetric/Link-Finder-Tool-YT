"""Receipt-first, non-retrying transport, with a durable $60 admission fence.

Provider calls use fixed hosts. Public website reads use fresh DNS validation
and a pinned public socket on every redirect, without credentials or proxies.
"""
import hashlib
import http.client
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, build_opener

from instagram_clickhouse_import import NoRedirects
from instagram_proof_trial import digest, safe_url

MAX_BYTES = 2_000_000
ALLOWED_SC = {
    "instagram/profile", "spotify/artist", "youtube/channel", "tiktok/profile",
    "twitter/profile", "soundcloud/artist", "linktree",
}


def utc():
    return datetime.now(timezone.utc).isoformat()


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_new(path, data):
    with Path(path).open("x", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, allow_nan=False, indent=2)
        f.flush()
        os.fsync(f.fileno())


def append_sync(path, data):
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, allow_nan=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def output_paths(root):
    pointer_path = Path(root) / "final-output.json"
    if pointer_path.exists():
        pointer = json.loads(pointer_path.read_text())
        if (pointer["results_directory"] != "artist-results-continuation"
                or pointer["decisions_manifest"] != "decisions-continuation-frozen.json"
                or pointer["policy_file"] != "continuation-policy.json"):
            raise ValueError("Unrecognized final trial output paths")
        frozen = Path(root) / pointer["decisions_manifest"]
        if file_sha(frozen) != pointer["decisions_sha256"]:
            raise ValueError("Final frozen decisions changed")
        return frozen, Path(root) / pointer["results_directory"], Path(root) / pointer["policy_file"]
    frozen = Path(root) / "decisions-frozen.json"
    if json.loads(frozen.read_text()).get("halted"):
        raise ValueError("Trial halted; do not unblind or publish as a completed trial")
    return frozen, Path(root) / "artist-results", Path(root) / "collection-policy.json"


def sanitized(value):
    """Retain auditable content, never credentials or signed media URLs."""
    if isinstance(value, dict):
        return {k: sanitized(v) for k, v in value.items() if k.lower() not in (
            "credits_remaining", "api_key", "apikey", "authorization", "access_token",
            "refresh_token", "cookie", "set-cookie",
        ) and not any(s in k.lower() for s in (
            "profile_pic", "avatar", "thumbnail", "image", "video_url", "display_url",
            "tracking_token", "business_email", "business_phone", "phone_number"))}
    if isinstance(value, list):
        return [sanitized(v) for v in value]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        # Exact source bytes get hashed before sanitization. Strip volatile
        # media URL query strings/tokens; no evidence rule uses media fields.
        host = (urlsplit(value).hostname or "").lower()
        if any(s in host for s in ("cdn", "googlevideo", "scontent", "ytimg")):
            return "[media URL omitted]"
    return value


class AdmissionError(RuntimeError):
    pass


class TrialTransport:
    def __init__(self, root, scope, *, enabled=False, continuation=False):
        self.root, self.scope, self.enabled = Path(root), scope, enabled
        self.lock = threading.RLock()
        self.serial = threading.Lock()
        self.halted = threading.Event()
        self.memory = {}
        self.reserved_cents = 0
        self.request_count = 0
        self.receipts = self.root / "receipts"
        self.receipts.mkdir(exist_ok=True)
        self.ledger = self.root / "admissions.jsonl"
        self.lockfile = None
        # An existing paid launch is never replayed by constructing a runner.
        if enabled:
            import fcntl
            self.lockfile = (self.root / "collector.lock").open("a")
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if not continuation and (self.ledger.exists() or (self.root / "launch.json").exists()):
                raise AdmissionError("Earlier launch exists; reconcile receipts, never auto-retry")
            expected = scope["approval_sha256"]
            if (file_sha(scope["approval_source"]) != expected or scope["max_spend_usd"] != 60
                    or scope["trial_rows"] != 200 or scope["full_run_authorized"]):
                raise AdmissionError("Approval/scope mismatch")
            # Read secrets only inside the transport; never save or print them.
            self.keys = {
                "sc": os.environ["SCRAPECREATORS_API_KEY"],
                "serper": os.environ["SERPERDEV_API_KEY"],
            }
            if continuation:
                self.load_saved_admissions()
            save_new(self.root / ("continuation-launch.json" if continuation else "launch.json"), {
                "run_id": scope["run_id"], "scope_sha256": digest(scope),
                "started_at": utc(), "max_spend_usd": 60,
                "automatic_retries": False, "concurrency": 6,
                "continuation": continuation, "prior_reservations_cents": self.reserved_cents,
            })

    def load_saved_admissions(self):
        """Offline reconciliation only. Even failed requests become cache
        tombstones, so no previously reserved resource can be charged again.
        """
        events = [json.loads(s) for s in self.ledger.read_text().splitlines() if s.strip()]
        reservations, acknowledgments, uncertain = {}, {}, {}
        for event in events:
            key = event["request_id"]
            if event["event"] == "reserved":
                if key in reservations or event["reserved_cents"] != 2:
                    raise AdmissionError("Duplicate or changed historical reservation")
                reservations[key] = event
            elif event["event"] == "acknowledged":
                if key in acknowledgments:
                    raise AdmissionError("Duplicate historical acknowledgment")
                acknowledgments[key] = event
            elif event["event"] == "uncertain":
                uncertain[key] = event
            else:
                raise AdmissionError("Unknown ledger event")
        if not set(acknowledgments) <= set(reservations) or not set(uncertain) <= set(reservations):
            raise AdmissionError("Unbound historical receipt")
        for key, reservation in reservations.items():
            if digest({"kind": reservation["kind"], "params": reservation["payload"]}) != key:
                raise AdmissionError("Historical operation identity changed")
            slot = {"ready": threading.Event()}
            ack = acknowledgments.get(key)
            if not ack:
                slot["error"] = "Retired uncertain request; no replay or paid fallback"
            else:
                path = self.receipts / (key + ".json")
                if file_sha(path) != ack["receipt_sha256"]:
                    raise AdmissionError("Saved provider receipt changed")
                packet = json.loads(path.read_text())
                if (packet["request_id"] != key or packet["kind"] != reservation["kind"]
                        or packet["params"] != reservation["payload"]):
                    raise AdmissionError("Receipt/reservation binding differs")
                if not ack["charge_bound_confirmed"] and packet["http_status"] == 200:
                    raise AdmissionError("Successful response with unbounded charge requires review")
                if packet["http_status"] in (401, 402, 429):
                    raise AdmissionError("Provider access/rate failure must be resolved before continuing")
                # Acknowledged failed requests remain failed evidence. Their
                # entire original reservation stays held; never retry them.
                slot["packet"] = packet
            slot["ready"].set()
            self.memory[key] = slot
        self.request_count = len(reservations)
        self.reserved_cents = sum(r["reserved_cents"] for r in reservations.values())
        if self.reserved_cents > 6000:
            raise AdmissionError("Historical spending exceeds approved cap")

    def admit(self, key, kind, payload):
        with self.lock:
            if not self.enabled:
                raise AdmissionError("Paid dispatch is disabled")
            if self.halted.is_set():
                raise AdmissionError("Run halted; no new paid requests admitted")
            if self.reserved_cents + 2 > 6000 or self.request_count >= 3000:
                self.halted.set()
                raise AdmissionError("Approved $60 ceiling reached")
            # Reserve the full ceiling before dispatch; never reclaim a failed,
            # unknown, cached, or acknowledged request during this trial.
            append_sync(self.ledger, {"event": "reserved", "request_id": key, "kind": kind,
                                     "payload": payload, "at": utc(), "reserved_cents": 2,
                                     "run_id": self.scope["run_id"]})
            self.reserved_cents += 2
            self.request_count += 1

    def paid(self, kind, params):
        if kind != "serper" and kind not in ALLOWED_SC:
            raise AdmissionError("Unsupported/unpriced endpoint")
        key = digest({"kind": kind, "params": params})
        # Unique provider resources are captured once. A global request lock
        # prevents duplicate dispatch before a shared receipt is available.
        # Artists run concurrently; request dedup is synchronized via futures.
        with self.lock:
            slot = self.memory.get(key)
            if slot is None:
                slot = {"ready": threading.Event()}
                self.memory[key] = slot
                owner = True
            else:
                owner = False
        if not owner:
            slot["ready"].wait()
            if "error" in slot:
                raise AdmissionError(slot["error"])
            return slot["packet"]
        try:
            self.admit(key, kind, params)
            if kind == "serper":
                url = "https://google.serper.dev/search"
                body = json.dumps(params).encode()
                headers = {"X-API-KEY": self.keys["serper"], "Content-Type": "application/json"}
                method = "POST"
            else:
                url = "https://api.scrapecreators.com/v1/" + kind + "?" + urlencode(params)
                body, headers, method = None, {"x-api-key": self.keys["sc"]}, "GET"
            status, raw = None, b""
            try:
                opener = build_opener(NoRedirects())
                try:
                    response = opener.open(Request(url, data=body, headers=headers, method=method), timeout=45)
                except HTTPError as e:
                    response = e
                with response:
                    status = response.status
                    raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError("Response exceeds evidence byte bound")
                data = json.loads(raw)
            except Exception as e:
                packet = {"request_id": key, "kind": kind, "params": params, "at": utc(),
                          "http_status": status, "state": "UNCERTAIN_CHARGE_NO_RETRY",
                          "response_sha256": hashlib.sha256(raw).hexdigest(),
                          "error_type": type(e).__name__}
                save_new(self.receipts / (key + ".json"), packet)
                with self.lock:
                    self.halted.set()
                    append_sync(self.ledger, {**packet, "event": "uncertain"})
                raise AdmissionError("Uncertain provider outcome; response fenced without retry") from None
            packet = {"request_id": key, "kind": kind, "params": params, "at": utc(),
                      "http_status": status, "response_sha256": hashlib.sha256(raw).hexdigest(),
                      "data": sanitized(data), "state": "RESPONSE_SAVED"}
            save_new(self.receipts / (key + ".json"), packet)
            credits = data.get("credits_charged") if isinstance(data, dict) else None
            credit_valid = (kind == "serper" or
                            (type(credits) in (int, float) and 0 <= credits <= 10))
            # The documented endpoints cost one credit. Isolate an
            # acknowledged resource/server failure with missing charge data;
            # retain its full 10-credit-compatible reservation and never replay.
            # Successful responses with missing/excessive charges still halt.
            isolated_failed_response = (status in (403, 404, 500, 502, 503, 504)
                                        and credits is None)
            fatal = status in (401, 402, 429) or (not credit_valid and not isolated_failed_response)
            if kind == "serper" and status >= 500:
                # Acknowledged server failures are saved, not retried. One
                # broken search must not be misrepresented as zero results.
                fatal = False
            with self.lock:
                append_sync(self.ledger, {"event": "acknowledged", "request_id": key,
                                         "at": packet["at"], "http_status": status,
                                         "credits_charged": credits if credit_valid else None,
                                         "kind": kind, "receipt_sha256":
                                         file_sha(self.receipts / (key + ".json")),
                                         "charge_bound_confirmed": credit_valid})
                if fatal:
                    self.halted.set()
            if fatal:
                raise AdmissionError("Provider access/charge bound needs review; no retry")
            slot["packet"] = packet
            return packet
        except Exception as e:
            slot["error"] = str(e) if isinstance(e, AdmissionError) else type(e).__name__
            raise
        finally:
            slot["ready"].set()


def public_address(address):
    ip = ipaddress.ip_address(address)
    return ip.version == 4 and ip.is_global and not ip.is_multicast and not ip.is_reserved


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, timeout=15, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def public_page(url):
    """Credential-free bounded reads, including a safe check for every hop."""
    current = safe_url(url)
    if not current:
        raise ValueError("Unsafe public URL")
    redirects, started = [], time.monotonic()
    for _ in range(4):
        parsed = urlsplit(current)
        addresses = {r[4][0] for r in socket.getaddrinfo(parsed.hostname, 443, socket.AF_INET, socket.SOCK_STREAM)}
        if not addresses or not all(public_address(a) for a in addresses):
            raise ValueError("Nonpublic DNS result")
        connection = PinnedHTTPS(parsed.hostname, sorted(addresses)[0])
        try:
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            connection.request("GET", path, headers={
                "Host": parsed.hostname, "User-Agent": "ArtistLinkEvidenceTrial/1.0",
                "Accept": "text/html,application/json;q=0.9",
                "Accept-Encoding": "identity",
            })
            response = connection.getresponse()
            status, location = response.status, response.getheader("Location")
            content_type = response.getheader("Content-Type", "")
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES or time.monotonic() - started > 45:
                raise ValueError("Public page bound exceeded")
        finally:
            connection.close()
        if status in (301, 302, 303, 307, 308) and location:
            new = safe_url(urljoin(current, location))
            if not new:
                raise ValueError("Unsafe redirect")
            redirects.append({"from": current, "to": new, "status": status})
            current = new
            continue
        return {"at": utc(), "source_url": safe_url(url), "final_url": current,
                "status": status, "content_type": content_type, "redirects": redirects,
                "body": raw.decode("utf-8", errors="replace"),
                "body_sha256": hashlib.sha256(raw).hexdigest()}
    raise ValueError("Public redirect limit")
