# fork_run

A new attempt of an evidence-ledger run that replays the recording up to a frame and runs live from there (Mission Control spec §8.4 `fork`; ADR-058 decision 3). Frames 0–N replay from the recording; the next model call runs live; tool results after N are served from the recorded cassette when the input digest matches and denied otherwise.

Oxagen mints the attempt and records its provenance; the harness that consumes the cassette is the engine that admitted the run (ADR-043), which resumes the attempt through evidence ingress.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/fork`
- MCP: none; no tool is built.
- CLI: none
- Authentication: session or API key; org Owner, Admin or Member, checked in the handler (`assertOrgRole`, `apps/app/ARCHITECTURE.md` §3.2) for the signed-in user or the key's creator (`resolveActingUserId`); a key with no recorded creator is refused `forbidden / no_principal`
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
- `conflict` (409), by `reason`: `fork_requires_ledger_run` (the run is a wrapped session: it has no attempt row to mint, whatever grade its seal recorded); `run_not_sealed` (no attempt has sealed); `replay_grade_below_fork` (the seal recorded `inspect` or `view`, or no grade); `from_seq_past_seal` (the branch point lies past the sealed recording); `gap_before_from_seq` (a content-bearing frame, or any frame whose digest was recorded, at or before the branch point has no retained body, so the cassette would have a hole before the fork; the seal's `body_missing` rule); `run_not_writable` (a cancel or an ingress pause took the run lock after the checks above passed); `run_attempts_exhausted` (the run has used its pinned `max_attempts`).

No recorder in this revision writes a grade this capability accepts: a ledger seal grades at the `harness` tier and caps at `view`, and a wrapped session is refused by name. The mint waits for the gateway-observed ledger lane (ADR-058 decision 3).

The grade is read from the seal and never recomputed: a run is forkable when its record says so (spec §8.4 "the interface renders the recorded grade and never a stronger word").
