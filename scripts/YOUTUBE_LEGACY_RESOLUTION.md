# Offline legacy YouTube resolution

The retained metadata receipts in
`generated-artifacts/youtube-no-link-20-usd2/ownership-check-execution/receipts`
prove these URL resolutions:

| Saved candidate | Requested address | Returned address | Returned channel ID |
| --- | --- | --- | --- |
| Shiloh.MMG | `https://www.youtube.com/c/ShilohBros` | `http://www.youtube.com/@shilohandbros` | `UCn3AViOfcFN4zIICMC5hvPg` |
| Parveen Kajla | `https://www.youtube.com/user/PARVEENKAJAL` | `http://www.youtube.com/@PARVEENKAJAL` | `UCZGyMisvox_kDtILhyqwWJQ` |

Receipt filenames, respectively:

- `efa5c89070ba87e18bc132c4b77b653bcd6c370542ae32b85325d2c28c789b92.json`
- `f58e6888caca91d7ff4712be2a1d21078e757a031e4b45d81895f75ebb5bbaad.json`

Offline normalization of both full archived packets succeeded. This proves
address resolution only. In particular, Shiloh & Bros is not thereby identified
as Shiloh.MMG, and Parveen's separate `UC3YYo-SiLz2RkthVXeDzb0w` candidate is
not merged with the legacy candidate. Historical outcomes, model answers,
captures, admissions and authorizations were not rewritten.

Legacy captures retain the raw receipt and its digest. Binding checks its exact
provider endpoint, GET request, sole URL parameter, request digest, response
status, timestamp and returned identities. The model-facing projection keeps
the requested and returned addresses and receipt/request digests without
duplicating the entire raw receipt. HTTP-to-HTTPS normalization is restricted
to exact allowed YouTube domains; invalid returned addresses cannot fall back
to a channel-ID address.

This change does not authorize another model evaluation or paid continuation.
Existing immutable execution files may differ from newly normalized captures;
do not overwrite them, bypass recovery checks or replay charged requests.

Regression checks (all offline, using synthetic minimized fixtures):

```sh
node --test scripts/src/youtube-ownership-{policy,execution,legacy}.test.mjs
```
