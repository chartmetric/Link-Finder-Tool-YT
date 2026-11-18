# Independent evidence review of the 58 suggested YouTube links

**Review date:** 18 November 2026  
**Scope:** all 58 exact artist/channel pairs, covering 56 artists, from
`generated-artifacts/youtube-test-100-coverage-75-20261117-recovery-cont1/youtube-suggestions.csv`.

## Result

The **65% target is not established** for this set. The available saved evidence
supports **3 correct, 2 wrong and 53 unsure/unscorable** pairs. All 58 were
examined; **0 are unreviewed**. Missing evidence is not a negative identity verdict.

| Original suggestion type | Total | Correct | Wrong | Unsure / unscorable | Unreviewed | Precision among binary-scorable pairs |
|---|---:|---:|---:|---:|---:|---:|
| Topic — auto-generated | 52 | 1 | 2 | 49 | 0 | 1/3 = 33.3% |
| Artist-facing — management unverified | 6 | 2 | 0 | 4 | 0 | 2/2 = 100% |
| All suggestions | 58 | 3 | 2 | 53 | 0 | 3/5 = 60% |

- **Confirmed share of all suggestions:** 3/58 = **5.2%**. This is a lower bound
  on supported correctness, **not an estimate that 94.8% are wrong**.
- **Binary-scorable reviewed precision:** correct / (correct + wrong) = **60%**,
  below 65%, but based on only five evidence-sufficient pairs. Excluding 53
  unresolved cases makes this a strongly selected subset, not full-set accuracy.
- **Full-set precision bounds:** 3/58 to 56/58 = **5.2%–96.6%**. Neither passing
  nor failing true full-set precision is demonstrated.
- At least **38 correct links out of 58** are needed to reach 65%; this review
  would need **35 additional confirmations**. It does not authorize collecting them.
- The 100% artist-facing subset result concerns two scorable pairs only, not all
  six artist-facing suggestions. It is not management/ownership accuracy.

## Method and limitations

A **single Replit Agent** performed an offline source-evidence adjudication. This
is independent reasoning from the saved verifier's answer, **not independent
human validation**, a second human vote, a blinded review or a held-out benchmark.
Historical verdicts were visible during archive inspection. No model response
or probability was used as a correctness label. No fresh source collection,
network request, paid work or database access was performed.

Labels are about representation of the **exact catalog artist**, bound by both
`profile_id` and `cm_artist`, on the **exact canonical channel ID**:

- **Correct:** captured corroboration beyond a matching name or candidate-outbound
  catalog link alone, such as catalog-bound repertoire plus an exact Spotify ID,
  or specific captured biography/repertoire matching the catalog.
- **Wrong:** affirmative evidence identifies another artist/entity's channel.
- **Unsure / unscorable:** examined but insufficient evidence to assign correct
  or wrong. Includes missing catalog context, name-only Topic captures,
  recordings without an exact catalog identity bridge, and ambiguous collections.
- **Unreviewed:** not examined. Zero in this deliverable; supported explicitly in
  the metrics implementation so it cannot be silently counted as confirmed.

This rubric assesses artist-facing **representation**, not who controls an
account. Supported Topic pages qualify as **auto-generated music presence**.
No correct grade proves management, grants an ownership claim, makes an import
eligible, or changes the production acceptance policy.

The observation window is the saved captures from 17–18 November 2026. This does
not establish the current state of a live account or any general validity window.
Search snippets remain search context, not captured video metadata; recordings
on a different uploader do not corroborate the suggested channel itself.

## Correct pairs

| Artist | Catalog profile / cm_artist | Canonical channel ID | Captured corroboration |
|---|---|---|---|
| Dj Charlie B | 79818 / 1243664 | UCpw3C1A7nPJ8NPbUDjTDx-A | Topic biography names the Canadian DJ and the single **30,000 ft**, matching catalog CA country and Spotify-bound repertoire. |
| THE DEADER END | 298605 / 11579894 | UCG2d1T9BLCRhQX_72VNZ1Pw | Channel biography names **Numb** and **Something Loud**; exact outgoing Spotify artist ID agrees with the catalog. Saved handle capture binds to this ID. |
| MATHX | 285465 / 13766461 | UC3hrTdaGuosZBhuzLn3KtRA | Captured same-channel video **tb6GbtfwnZA** self-credits MATHX and **Real To Me**, matching catalog repertoire; channel links the exact Spotify artist ID. |

## Wrong pairs

| Artist | Catalog profile / cm_artist | Canonical channel ID | Affirmative counter-evidence |
|---|---|---|---|
| Trendy Boy | 3813704 / 15911385 | UCx4SGzlJQNiYtonugf61HAg | Channel capture is **DJ Save - Topic**. Same-channel **TP7fP1rHGGs** credits DJ Save, featuring Trendy Boy and Jade. A featured artist does not inherit the main artist's Topic channel. |
| Section Five | 3902228 / 3635226 | UCtQq215xCsF02K6SNLQCpmw | Channel capture is **Balcony Mix Africa - Topic**. Same-channel **rfGvN4L1-PQ**, *Istina*, co-credits Section Five with Balcony Mix Africa, Artwork Sounds and others. |

These are new review findings, **not historical model rejections** and not
artist-specific production overrides.

## Important unresolved cases

- **Tom Carroll → Wicked With You**, **Br@m → Ambiance** and **Georgia Cait →
  Unsure**: captures have collection names and collection-help links rather than
  an established exact artist-channel identity. Original Topic suggestion labels
  are retained as historical classifications, not independently confirmed types.
- **Kuto** has two different suggested Topic IDs. Neither capture binds the
  catalog's *My Love* release. Both remain unsure; they are not aliases by name.
- **NightBliz, KLWCI and Kid Reverie** have same-channel music credits, but the
  captured recordings lack an exact saved catalog music/account bridge.
  These are not rejections of their music presence.
- **4cyzon, CHEZ, Citizen Audrey and LoaMilano** have promising exact outgoing
  Spotify links. These alone are not sufficient independent corroboration.
  CHEZ's two catalog Spotify identities and misspelled `instragram.com` link are
  retained rather than silently repaired. Repertoire in search text is not
  promoted to a captured recording.
- **THE DEADER END's separate Topic ID** does not inherit the positive grade
  assigned to its artist-facing channel.

All 58 individual rationales are in `youtube-58-adjudications.json`, anchored to
the byte-hash-frozen source CSV. The generated reviewed CSV expands every row to
its exact catalog identities, channel ID, original model assessment, review label,
scorability, rationale, receipt reference, raw-byte hash and capture time.

## Historical coverage and shared-channel hold

Keep the original **56/100 artist suggestion coverage** separate from precision.
Recovery newly covered **32 artists**, while **one previously suggested artist
was placed on a shared-channel hold**: **25 + 32 − 1 = 56**, net **+31**.
These are historical suggestion counts, not confirmed-correct artist counts.

The shared channel **UCtXS5ljfO4NG94I6ResVFKg** remains held for:

- **Villager SA** — profile 3783654 / cm_artist 7006976;
- **Mokgaetse** — profile 4152222 / cm_artist 16284853.

Both retain “Same channel appeared for multiple artists; ownership unresolved.”
Neither is included in the 58-link scoring set. No hold, historical model answer,
archive, campaign counter or catalog link was modified. Kuto and THE DEADER END
each contribute two distinct channel suggestions but one artist each.

## Reproduce and inspect

```sh
node --test scripts/src/youtube-suggestion-accuracy.test.mjs
node scripts/src/youtube-suggestion-accuracy.mjs
```

Outputs go only to `generated-artifacts/youtube-58-accuracy-review-20261118/`:

- `review.html`: self-contained readable report with all 58 pairs and expandable evidence;
- `reviewed-pairs.csv`: full reviewed-pair table;
- `metrics.json`: exact numerators, denominators, bounds and preserved holds;
- `evidence.json`: saved catalog context and original receipt references/payloads,
  kept separate from archived model verdicts.

The builder checks source-export byte hashes before and after generation. For
every channel and cited same-channel video it verifies exact artist identities,
capture time, request binding and original raw provider bytes in the owning
archive. Captured handles are resolved only through their saved canonical IDs.
It never interprets a reconstructed packet digest as the original provider-byte
digest. The main application and its paid-worker workflows are unchanged.

## Shared fixes suggested by these findings, not activated

1. Require channel-level artist identity rather than allowing a collaborator
   credit on an auto-generated video to qualify another artist's Topic channel.
2. Preserve collection-versus-artist-channel ambiguity through normalization and
   prevent a search snippet's Topic wording from silently resolving that ambiguity.

No artist-specific overrides, catalog imports, new paid work or production
policy changes are included or authorized.
