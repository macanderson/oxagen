# bisect_runs

The first frame at which two recordings diverge (Mission Control spec §8.4 "bisect between any two runs of the same task"; ADR-058). Both runs are read frame by frame and each frame is reduced to a bisect key from its receipt; bodies are never read, so bisect works at grade `inspect` and above.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/bisect`
- MCP: `bisect_runs`
- CLI: none
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `bisect_runs`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runA` | string | yes | `arun_…` or `tse_…` |
| `runB` | string | yes | `arun_…` or `tse_…`; may equal `runA` |

## The key

`<type>[:<tool>=<status>][:<model>][:policy=<decision>][:verdict=<verdict>][:rows=<n>]` — the frame's kind, then the identity of what it did as far as its receipt says: the tool and its outcome for a tool call, the provider and model for a model call, the decision for a policy or approval frame, the verdict for a verification, the row count for an assembled context. Two frames with equal keys did the same thing as far as the record says.

## Output

| Field | Type | Description |
|---|---|---|
| `divergentSeq` | string or null | run A's sequence at the first position whose keys differ (run B's when A has ended); null when the runs agree throughout and have the same length |
| `divergentSessionUuid` | uuid, absent on a run's own chain | the subagent chain the frame `divergentSeq` names lies on, in whichever run it names. A subagent chain numbers its frames from 0, so the seq alone would name a frame on the run's own chain |
| `keyA`, `keyB` | string or null | the keys at that position; null for the run that has no frame there |
| `aligned` | integer | positions compared before the divergence, or in total when there is none |

Alignment is by position, so a ledger run and a wrapped session can be compared. A wrapped run is read as every chain it recorded: each subagent chain is spliced in after the `subagent_start` that spawned it, the order `get_run_transcript` shows, and every recorded frame is kept (#3823). A run longer than 10,000 frames, counted over every chain, is compared over its first 10,000: a divergence inside that prefix is answered, and two runs whose prefixes agree when either was cut are refused, because the frames past the cap were never compared.

## Errors

- `not_found` (404): either run is outside the caller's workspace.
- `conflict` (409), `reason: run_exceeds_bisect_cap`: the first 10,000 frames of both runs agree and at least one run has more, so no answer covers the whole recording.
