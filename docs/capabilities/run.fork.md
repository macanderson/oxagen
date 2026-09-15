# run.fork

A new attempt of an evidence-ledger run that replays the recording up to a frame and runs live from there (Mission Control spec §8.4 `fork`; ADR-058 decision 3). Frames 0–N replay from the recording; the next model call runs live; tool results after N are served from the recorded cassette when the input digest matches and denied otherwise.

Oxagen mints the attempt and records its provenance; the harness that consumes the cassette is the engine that admitted the run (ADR-043), which resumes the attempt through evidence ingress.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/fork`
- MCP: none. MCP callers authenticate with an API key, which carries no org role, and the handler checks one.
- CLI: none
- Authentication: session; org Owner, Admin or Member, checked in the handler (`assertOrgRole`, `apps/app/ARCHITECTURE.md` §3.2)
- Capability name: `fork_run`
- `mutates: true`; `agent.requiresApproval: false`; not billed (`noBillingGate: true`): minting the attempt is not a governed action, the actions the fork takes are metered as they happen. IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…`; a wrapped session is refused with `conflict` (`fork_requires_ledger_run`) |
| `fromSeq` | string | yes | decimal `run_seq` ≥ 1: the last recorded frame the fork replays |

## Output

| Field | Type | Description |
|---|---|---|
| `attemptId` | string | the minted attempt's public id (`arat_…`) |
| `attemptNumber` | integer | its number on the run |

The attempt carries the sealed attempt's engine identity, `resumed_from_attempt_id` naming the attempt it branches from, and `forked_from_run_seq = fromSeq`.

## Errors

- `forbidden` (403): the actor holds none of Owner, Admin, Member in the org.
- `not_found` (404): no ledger run with that id in the caller's workspace.
- `conflict` (409), by `reason`: `fork_requires_ledger_run` (the run is a wrapped session: it has no attempt row to mint, whatever grade its seal recorded); `run_not_sealed` (no attempt has sealed); `replay_grade_below_fork` (the seal recorded `inspect` or `view`, or no grade); `from_seq_past_seal` (the branch point lies past the sealed recording); `gap_before_from_seq` (a frame at or before the branch point carried content whose body was not retained, so the cassette would have a hole before the fork).

The grade is read from the seal and never recomputed: a run is forkable when its record says so (spec §8.4 "the interface renders the recorded grade and never a stronger word").
