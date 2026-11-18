"""Fresh-trial $20 fence with durable maximum reservations and settlements.

Known acknowledged usage is conservatively priced at $0.004/SC credit and
$0.002/Serper query, above the saved public starter-price references. Unknown
charges keep the entire maximum reservation. No operation is ever replayed.
This is a new approval/ledger, not a release of the closed prior trial's funds.
"""
import fcntl
import json
import os
from decimal import Decimal, ROUND_CEILING

from instagram_proof_trial import digest
from instagram_trial_transport import (
    AdmissionError, TrialTransport, append_sync, file_sha, save_new, utc,
)


class Transport(TrialTransport):
    def __init__(self, root, scope, *, enabled=False):
        super().__init__(root, scope, enabled=False)
        self.liability_microusd = 0
        self.reservations, self.settled = {}, set()
        if not enabled:
            return
        if (scope["max_spend_usd"] != 20 or scope["trial_rows"] != 200
                or scope["full_run_authorized"] or scope["model_calls_authorized"]
                or file_sha(scope["approval_source"]) != scope["approval_sha256"]):
            raise AdmissionError("Fresh $20 approval/scope mismatch")
        self.lockfile = (self.root / "collector.lock").open("a")
        fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if self.ledger.exists() or (self.root / "launch.json").exists():
            raise AdmissionError("Existing launch: reconcile receipts, never auto-replay")
        self.keys = {"sc": os.environ["SCRAPECREATORS_API_KEY"],
                     "serper": os.environ["SERPERDEV_API_KEY"]}
        self.enabled = True
        save_new(self.root / "launch.json", {
            "run_id": scope["run_id"], "scope_sha256": digest(scope),
            "started_at": utc(), "max_spend_usd": 20, "automatic_retries": False,
            "maximum_reserved_before_every_dispatch": True,
            "settle_only_acknowledged_known_usage": True,
        })

    def admit(self, key, kind, payload):
        amount = 2000 if kind == "serper" else 40000
        with self.lock:
            if not self.enabled or self.halted.is_set():
                raise AdmissionError("Paid dispatch disabled or halted")
            if (self.liability_microusd + amount > 20_000_000
                    or self.request_count >= self.scope["max_paid_requests"]):
                self.halted.set()
                raise AdmissionError("Approved $20 ceiling or request bound reached")
            if key in self.reservations:
                raise AdmissionError("Duplicate paid reservation")
            append_sync(self.ledger, {
                "event": "reserved", "request_id": key, "kind": kind, "payload": payload,
                "at": utc(), "reserved_microusd": amount, "run_id": self.scope["run_id"]})
            self.reservations[key] = amount
            self.liability_microusd += amount
            self.reserved_cents = self.liability_microusd / 10000
            self.request_count += 1

    def paid(self, kind, params):
        packet = super().paid(kind, params)
        key = packet["request_id"]
        with self.lock:
            if key in self.settled:
                return packet
            reserved = self.reservations[key]
            credits = packet.get("data", {}).get("credits_charged")
            if kind == "serper":
                charged = reserved
            elif type(credits) in (int, float) and 0 <= credits <= 10:
                charged = int((Decimal(str(credits)) * 4000).to_integral_value(rounding=ROUND_CEILING))
            else:
                charged = reserved
            if charged > reserved:
                self.halted.set()
                raise AdmissionError("Acknowledged usage exceeded its pre-dispatch maximum")
            append_sync(self.ledger, {
                "event": "settled", "request_id": key, "at": utc(),
                "retained_microusd": charged, "released_microusd": reserved - charged,
                "receipt_sha256": file_sha(self.receipts / (key + ".json")),
                "unknown_charge_full_reservation_retained": (
                    kind != "serper" and type(credits) not in (int, float)),
            })
            self.liability_microusd -= reserved - charged
            self.reserved_cents = self.liability_microusd / 10000
            self.settled.add(key)
        return packet
