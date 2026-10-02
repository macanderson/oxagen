# get_run_chain

**Surfaces:** api, mcp, agent, cli

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
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Why this is its own capability and not more of `get_run`

`get_run` is the per-render read and the long-poll target: an open run calls it every `waitMs`, forever, and every field it carries is paid for on each of those calls. The chain is the opposite shape — it is read once, when a person opens the tab, and after the seal it never changes again. Folding it into `get_run` would make every poll of every live run walk the frames for missing sequences and missing bodies and read the checkpoint table, to answer a question nobody asked on that render.

They also differ in what they may refuse. `get_run` must answer for any run a workspace holds; this read walks the recording, so it is bounded and says so (`complete: false`) rather than silently reporting the gaps of a prefix as the gaps of the run. A field that can honestly answer "I did not look at all of it" does not belong on the read a page header depends on.

No new store: the ledger's seal rows, the wrapped session's checkpoints and the frames already recorded are all it reads.

## Subagent chains

A wrapped run's subagents each record on a hash chain of their own, with their own dense `seq` from 0, their own `tacho.sessions` row and their own checkpoints (#3823). A gap computed over frames spliced from several chains would mean nothing, so each subagent chain is walked on its own and answered in `chains`, with its gaps numbered on its own `seq`. `frameCount`, `firstSeq`, `lastSeq` and `gaps` at the top describe the run's own chain only.

- Postgres lists the chains under the run's root, in the order they started, up to 200.
- Their frames are one read of up to 10,000 rows across them, a budget of its own beside the run's chain. ClickHouse answers a chain's rows together, so when that read is cut, the chain the cut fell in and every listed chain that returned no frame are marked `complete: false`, and no tail is reported missing on them.
- A chain is bounded from seq 0, unless its frames may have expired from `tacho_events` (#4316), and to its own `seq_count` only when it was read whole: the rules the run's own chain follows.
- Its checkpoints are read by its session row id, in one query for every chain.
- The ladder reads every chain. A sequence gap on a subagent's chain is a `chain_break` in the run's record, and a missing body there is a `body_missing`.
- A gap a subagent chain's seal recorded, such as `unobserved_tail`, caps the ladder too. When the run has more than 200 chains, one more query reads the gaps every chain recorded, so a chain past the list still caps it.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `hashRule` | `tacho.sha256_prev_hash_v1` \| `ledger.event_stream_digest_v1` | how the store chains a frame to the one before it, so a verifier recomputes with this rule and nothing else |
| `frameCount` | integer | frames the walk read on the run's own chain |
| `firstSeq`, `lastSeq` | string or null | the first and last sequence read; null on a run with no frame yet |
| `merkleRoot` | string or null | the latest attempt's root, for a quick render. A sealed wrapped session's is `tacho.sessions.final_hash`, the whole-session commitment `terminalPatch` writes at `agent_stop`. It is not a checkpoint's chain head, which can cover only a prefix once the collector stops checkpointing at seal. A wrapped session that is still recording answers its newest checkpoint's chain head, or null before its first checkpoint. An unsealed ledger run answers null |
| `checkpoints` | object[] | `{ seq, chainHead, eventCount, signedAt, deviceKeyFingerprint, platformKeyId, countersignedAt, anchorRoot, anchoredAt }`, in `seq` order. The host's collector seals a `checkpoint` frame about once a minute on a chain that moved, signed with the host's device key. Ingest stores one entry for each such frame whose signature verifies against the key the host enrolled with (ADR-253). A frame that does not verify gets no entry, so every entry here was verified. `seq` is the last frame the checkpoint covers, and `eventCount` is the number of frames under it. The platform does not countersign or anchor checkpoints yet, so `platformKeyId`, `countersignedAt`, `anchorRoot` and `anchoredAt` are null. A session recorded before ADR-253 shipped has no entries. A ledger attempt commits at its seal and checkpoints nothing in between, so it answers none |
| `gaps.missingSequences` | `{ from, to }[]` | sequences missing between the first and the last frame read, inclusive. Only the interior: a recording that starts at 7 is not missing 1 to 6 |
| `gaps.missingFrameCount` | integer | how many sequences those runs account for |
| `gaps.missingBodies` | integer | frames that carried content and whose bytes were not retained |
| `gaps.recorded` | string[] | the gaps the seal recorded, from the closed vocabulary (spec §13.1). A word the store holds that the vocabulary does not name is dropped rather than passed on |
| `seals` | object[] | one entry per attempt, oldest first: `{ sealedAt, terminalStatus, eventCount, finalRunSeq, finalEventDigest, eventStreamDigest, merkleRoot, archiveSegmentRef, archiveSegmentDigest, attestation }`. Empty while the run is unsealed. A retried ledger run carries one seal per attempt here, matching the frame count and gap analysis above, which already span every attempt. `archiveSegmentDigest` and `attestation` are described below |
| `enforcementTier` | `gateway` \| `harness` \| `observe` | where the run's actions were observed from (spec §8.4) |
| `recordedGrade` | `inspect` \| `view` \| `fork` \| `retry`, or null | the grade the seal recorded; null while the run is live or its seal predates the recorder. Never recomputed on read |
| `ladder` | object[] | `{ grade, met, reason }` per rung |
| `complete` | boolean | false when the run's own chain has more than 10,000 frames, so the gaps are a prefix's, when a subagent chain was cut short, or when the run has more than 200 subagent chains |
| `chains` | object[], absent on a ledger run | each subagent chain of a wrapped run, walked on its own: `{ sessionUuid, parentSessionUuid, subagentId, subagentType, frameCount, firstSeq, lastSeq, gaps, checkpoints, finalHash, sealedAt, complete }`. `gaps` is `{ missingSequences, missingFrameCount, missingBodies }` on the chain's own `seq`. `finalHash` and `sealedAt` are the chain's seal, null while it is unsealed. `complete` is false when the walk stopped before the chain's last frame. Empty on a wrapped run with no subagent |

### The seal's attestation

Each seal carries two fields for the run attestation (spec §8.3, #4000):

| Field | Type | Description |
|---|---|---|
| `archiveSegmentDigest` | string or null | `sha256:` over the archive segment's bytes as stored, the digest the attestation signs. Null on a seal written before the digest was recorded, and on a wrapped session's seal |
| `attestation` | object or null | `{ alg, keyId, sig, signsOver }`. `alg` is `ed25519`, `keyId` names the attester key, and `sig` is base64 over the RFC 8785 canonical JSON of the signed payload. `signsOver` names the signed fields and carries no copy of their values: `run_id`, `attempt_id`, `frame_count`, `merkle_root`, `archive_segment_digest`, `enforcement_tier`, `completeness_gaps` and `replay_grade`. The seal entry lacks four of those values: the attempt's public id and the seal's own tier, gaps, and grade (#4399). Check a signature from the `export_run` bundle with `oxagen verify`. Null on a seal written before attestation, on a seal written with no attester key configured, and on a wrapped session's seal |

Oxagen signs a seal once, when it writes it, and never signs an older seal after the fact (ADR-195). The key is the deployment's attester key ([`TACHO_BUNDLE_SIGNING_PRIVATE_KEY`](../../packages/config/src/registry.ts)), the one `export_run` signs with. A deployment with no usable key writes the seal with no signature, and the seal still commits.

To check a signature, export the run with `export_run`. The bundle carries each attempt's payload beside the signature the seal wrote when the seal's key is the deployment's current key, and `oxagen verify` or the bundled `verify.mjs` checks it offline. This read names the fields only, because a retried run's earlier attempts carry gaps and a grade this read does not repeat per seal.

`oxagen run chain` prints one line per seal: `Attestation: ed25519 key <keyId> over <fields>`, or `Attestation: not recorded`. A retried run numbers the lines by attempt.

### The ladder's reasons

A met rung names what carries it: `frames_recorded`, `bodies_retained`, `tool_cassette_complete`, `harness_reproducible`. An unmet rung names the single thing missing: a comma-joined list of blocking gap kinds, `no_retained_bodies`, `observe_tier`, `tool_bodies`, `enforcement_tier:<tier>`, or `harness_not_reproducible`.

The ladder is computed from what this read can see — the gaps the seal recorded, plus a chain break or a missing body the walk found on any chain that the seal did not name — so a rung may read stronger or weaker than `recordedGrade`. **The recorded grade is what a caller renders**, and nothing raises it (spec §8.4); the ladder says why.

## Errors

- `not_found` (404): no run with that id in the caller's workspace.
