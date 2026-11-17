---
name: Mixed channel recovery boundary
description: Why generic saved channel metadata recovery must not inherit specialized conflict acknowledgments.
---

Generic saved-channel-response recovery acknowledges only valid, known-billing,
identity-conflict-free metadata. Keep identity-conflicting metadata unresolved.
Do not inherit an older specialized tool's permission to acknowledge a held
conflict as transport-only receipt.

**Why:** The user explicitly required failed/unknown-charge and identity-conflicting
metadata to stay unresolved in this general workflow. Earlier uploader and
specific direct-channel recoveries had narrower, separately approved exceptions;
those exceptions are not a standing authorization.

**How to apply:** Keep offline audit, exact zero-spend acknowledgment approval and
fresh exact untouched-continuation approval separate. Never generalize a historic
conflict-specific approval, rewrite the original archives, or reset reservations
to make a new continuation pass.
