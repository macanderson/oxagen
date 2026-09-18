# run.chain.get

What makes one run's record tamper-evident, and what it is missing (Mission Control spec §8.3, §8.4; the Run page's Chain-and-seal tab). It answers the rule the chain was built under, the Merkle root the seal committed to, the signed checkpoints along the way, the gaps the read can see, the seal itself, and the replay-grade ladder with the reason each rung is or is not reached.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/chain`
- MCP: `get_run_chain`
- CLI: `oxagen run chain <run-id> [--json]`
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `get_run_chain`
- Not billed (`noBillingGate: true`): reading a recording is a console read (ADR-052 exclusion 2). IAM default-deny; medium sensitivity.

## Why this is its own capability and not more of `get_run`

`get_run` is the per-render read and the long-poll target: an open run calls it every `waitMs`, forever, and every field it carries is paid for on each of those calls. The chain is the opposite shape — it is read once, when a person opens the tab, and after the seal it never changes again. Folding it into `get_run` would make every poll of every live run walk the frames for missing sequences and missing bodies and read the checkpoint table, to answer a question nobody asked on that render.

They also differ in what they may refuse. `get_run` must answer for any run a workspace holds; this read walks the recording, so it is bounded and says so (`complete: false`) rather than silently reporting the gaps of a prefix as the gaps of the run. A field that can honestly answer "I did not look at all of it" does not belong on the read a page header depends on.

No new store: the ledger's seal rows, the wrapped session's checkpoints and the frames already recorded are all it reads.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `hashRule` | `tacho.sha256_prev_hash_v1` \| `ledger.event_stream_digest_v1` | how the store chains a frame to the one before it, so a verifier recomputes with this rule and nothing else |
| `frameCount` | integer | frames the walk read |
| `firstSeq`, `lastSeq` | string or null | the first and last sequence read; null on a run with no frame yet |
| `merkleRoot` | string or null | the root the seal committed to (a wrapped session's is its last checkpoint's chain head); null while the run is unsealed |
| `checkpoints` | object[] | `{ seq, chainHead, eventCount, signedAt, deviceKeyFingerprint, platformKeyId, countersignedAt, anchorRoot, anchoredAt }`. A ledger attempt commits at its seal and checkpoints nothing in between, so it answers none |
| `gaps.missingSequences` | `{ from, to }[]` | sequences missing between the first and the last frame read, inclusive. Only the interior: a recording that starts at 7 is not missing 1 to 6 |
| `gaps.missingFrameCount` | integer | how many sequences those runs account for |
| `gaps.missingBodies` | integer | frames that carried content and whose bytes were not retained |
| `gaps.recorded` | string[] | the gaps the seal recorded, from the closed vocabulary (spec §13.1). A word the store holds that the vocabulary does not name is dropped rather than passed on |
| `seal` | object or null | `{ sealedAt, terminalStatus, eventCount, finalRunSeq, finalEventDigest, eventStreamDigest, merkleRoot, archiveSegmentRef }`; null while the run is unsealed |
| `enforcementTier` | `gateway` \| `harness` \| `observe` | where the run's actions were observed from (spec §8.4) |
| `recordedGrade` | `inspect` \| `view` \| `fork` \| `retry`, or null | the grade the seal recorded; null while the run is live or its seal predates the recorder. Never recomputed on read |
| `ladder` | object[] | `{ grade, met, reason }` per rung |
| `complete` | boolean | false when the run has more than 10 000 frames, so the gaps are a prefix's |

### The ladder's reasons

A met rung names what carries it: `frames_recorded`, `bodies_retained`, `tool_cassette_complete`, `harness_reproducible`. An unmet rung names the single thing missing: a comma-joined list of blocking gap kinds, `no_retained_bodies`, `observe_tier`, `tool_bodies`, `enforcement_tier:<tier>`, or `harness_not_reproducible`.

The ladder is computed from what this read can see — the gaps the seal recorded, plus a chain break or a missing body the walk found that the seal did not name — so a rung may read stronger or weaker than `recordedGrade`. **The recorded grade is what a caller renders**, and nothing raises it (spec §8.4); the ladder says why.

## Errors

- `not_found` (404): no run with that id in the caller's workspace.
