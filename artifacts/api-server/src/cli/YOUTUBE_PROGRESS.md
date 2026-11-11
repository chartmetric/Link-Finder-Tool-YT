# Saved YouTube test progress

The read-only `GET /api/bulk/youtube-artist-progress` endpoint serves a
counter-only snapshot from the existing shared export storage. It never imports
paid workers, reads provider credentials, makes provider requests, or claims work.
The saved snapshot is available after server restarts and outside the workspace.

To refresh the snapshot explicitly from completed saved evidence:

```sh
pnpm --filter @workspace/api-server run youtube:publish-progress \
  --publish --run-id=youtube-no-link-20-usd2
```

The publisher requires the exact approved test identity, validates every artist
against the approved scope, and checks the completed ownership phase and combined
reservations using a read-only PostgreSQL transaction. It does not alter spending
tables, restart workers, or start a continuous YouTube campaign. Snapshot writes
use generation preconditions and reject older evidence or a different scope.

Counting rules:

- Search progress is completed successful searches / approved test artists.
- A completed search with no candidate is a valid separate outcome, not proof that
  an artist has no channel.
- An artist is checked if at least one candidate has a saved ownership assessment:
  a recorded model verdict (including uncertainty), or a deterministic ownership
  policy result such as Topic/organization classification or an observed conflict.
- Multiple candidate decisions still count as one checked artist or likely match.
- Success rate is artists with a likely review suggestion / checked artists,
  not raw search hits, channel count, all catalog artists, or confirmed ownership.
- Held-size checks and unbound metadata alone do not count as checked or rejected.
  Pending candidates remain visible even when their artist has another assessed
  candidate.
- Reservations combine the original discovery and subsequent ownership phase
  within the separate original $2 YouTube cap. They are not actual invoiced costs.

The UI labels the result as a test, distinguishes completed searches from partial
ownership checking, and never treats the Instagram campaign as a YouTube campaign.
