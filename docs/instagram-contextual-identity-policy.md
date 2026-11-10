# Saved-evidence ownership checks

`corroborated-artist-evidence-v3` and `contextual_artist_ownership_v3` are explicit,
offline-only options. Existing production/default rules and the archived v2
policy/rubric remain unchanged.

The shared changes:

- Recognize exact artist handles, explicit self-introductions and strongly
  catalog-backed aliases instead of requiring the display name to match.
- Distinguish musician label affiliations from a label account's own identity.
  Explicit label, fan and other organization accounts still remain held.
- Recognize DJ and other explicit music professions, without treating a role
  or a favorable model answer as ownership proof.
- Allow one distinctive catalog release in the biography to combine with at
  least two separately attributed, first-person release posts covering two
  distinct catalog titles. URL variants of the same post are not independent.
- Include original bounded catalog texts with source binding, dates and
  staleness in new request drafts. Unrelated or stale context is not ownership
  proof. Refuse to omit context or post evidence to fit the 6000-byte cap.

The offline comparison checks source/roster and request hashes, binds original
scores/verdicts to recorded response packets, reproduces v2 support first, and
retains shared-handle holds. It never calls providers or writes live links.
Its CSV changes are counterfactual support using historical model answers,
not new verifications. Answers to older prompts cannot be attributed to the
new fuller prompts. Synthetic controls do not establish calibrated accuracy.

From the workspace root, use an unused output directory:

```
node scripts/src/instagram-contextual-identity-check.mjs <frozen-batch-directory> <new-output-directory>
```

Outputs include 500-artist before/after results, candidate-level reasons,
unchanged recorded scores, unsent request drafts, held oversized requests,
input hashes and code hashes. Original archives are not overwritten.
Any paid verification using the new prompts needs separate spending approval.
