# seal_run

**Surfaces:** api, mcp

Seal a wrapped run that the control plane still reads as live, and queue a kill for its agent ([ADR-168](../adr/ADR-168-an-operator-seals-a-run-and-its-agent-is-killed.md), issue #4073).

A wrapped session seals when its host sends `agent_stop`, or when the control plane closes it after twelve hours with no event (`idle_timeout`, ADR-159). A run whose agent finished without either reads as live on Fleet and the Run page until then. Its cost stays an estimate and its wall clock keeps counting. A `dispatch_command` cancel stops the agent, but the run stays open until the host's sweep sees the process gone. `seal_run` closes the run now.

The call seals the root session and every chain of the run that is open or idle-closed, in one transaction. It writes the columns the idle close writes: outcome `unknown`, the end at the last event received, the head the control plane holds as the final hash, and an unobserved tail, which grades the recording `inspect`. Only the source differs: `seal_source = 'operator'`. The outcome stays `unknown` because an operator's seal says the run is over, not how it ended. After the commit the handler sends `cost/run.sealed`, which rolls up the run's cost as final. If that send fails, the nightly sweep rolls the run up.

In the same transaction the call queues a `kill` command for the agent on the run's host, when that host can collect a command. The host takes it on its next ingest response or command poll (`fetch_commands`). `list_commands` reports what became of it.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/seal`
- MCP: `seal_run`
- Authentication: session or API key. The handler requires org Owner or Admin, or workspace Owner on the workspace the call is scoped to, of the signed-in user or the key's creator (`assertOrgRole`, `resolveActingUserId`). A workspace Member cannot seal a run, and can still cancel one with `dispatch_command`. A key with no recorded creator is refused `forbidden` / `no_principal`.
- App: the Run page (`/[org]/[ws]/runs/[run]`) offers Seal run on a live or idle-closed wrapped run.
- Capability name: `seal_run`
- `mutates: true`; `agent.requiresApproval: true`, `riskLevel: high`. Not billed (`noBillingGate: true`): a lapsed bucket must not leave a finished agent running. IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | a wrapped run's `tse_…` id, live or idle-closed. The schema also accepts an `arun_…` id, which the handler refuses (`ledger_run`) |
| `reason` | string | no | 1 to 512 characters. The kill command records it |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | the run the call sealed |
| `sealedAt` | string | RFC 3339. When the control plane sealed the run |
| `sessionsSealed` | integer | the chains the call sealed: the root and every subagent still open. At least 1 |
| `kill` | object | `{ status: "queued", commandId }` with the `tcm_…` command the host collects next, or `{ status: "not_sent", reason }` when no host can collect it |

`kill.reason` is the `commandBlock` value `list_runs` reports for the run (`commandBlockOf`). The handler refuses a sealed run before it reaches this point, so the reason is one of three:

- `no_host`: the session names no enrolled host.
- `host_revoked`: the host's enrollment was revoked.
- `host_offline`: the host has not polled for commands in five minutes.

The seal goes ahead in each case. A finished agent on an unreachable host has nothing left to stop.

## Kill on the host

The host applies `kill` the way it applies `cancel`, with SIGKILL in place of SIGTERM (`packages/tacho/src/collector/inbox.ts`). It marks the session cancelled, so the hook handler denies every later tool call with `session_cancelled`. It sends the signal to the agent's pid. It chains an `oxagen:command_applied` event with `session_killed`, and an `oxagen:kill_attempted` event with the signal and its outcome. The acknowledgement reports what the signal did, not that the host read the command.

The pid comes from the harness's environment (`pidFromEnv`, `packages/tacho/src/collector/hook-handler.ts`):

| Harness | Pid source | Effect of the kill |
|---|---|---|
| Claude Code | `CLAUDE_PID`, which Claude Code exports | SIGKILL to the pid. Acknowledged `applied` when the signal is delivered |
| Stella | `TACHO_HARNESS_PID`, which `tacho-hook` finds from its parent process | SIGKILL to the pid. Acknowledged `applied` when the signal is delivered |
| Codex | none | no signal. Acknowledged `failed` with `SIGKILL was not delivered (no_pid)`. Every later tool call is denied |
| Cursor | none | no signal. Acknowledged `failed` with `SIGKILL was not delivered (no_pid)`. Every later tool call is denied |

A process that has already exited refuses the signal, and the host acknowledges `failed` with `(failed)`. The seal stands in every case.

## Refusals

- `not_found` (404) `run_not_found`: no run with that id in the caller's workspace.
- `conflict` (409) `ledger_run`: the id names an evidence-ledger run (`arun_…`). Its producer seals it, and a `dispatch_command` cancel fences its ingress and revokes its run credentials.
- `conflict` (409) `run_sealed`: the run is already sealed for good, by its host (`agent_stop`), by an operator, or before the `seal_source` column existed. A host seal that commits while the call runs refuses it the same way. An idle-closed run (`idle_timeout`) is not refused.
- `forbidden` (403) `org_role_required`: the actor holds none of org Owner, org Admin, or workspace Owner.
- `forbidden` (403) `no_principal`: the API key has no recorded creator.

## Finality

A later frame does not reopen an operator's seal, and a later `agent_stop` does not replace it. Ingest treats every seal except `idle_timeout` this way. Frames the host sends after the seal still land on the chain as evidence, past the final hash the seal recorded, and the run's status does not change. `list_runs` and `get_run` answer `sealSource: operator`. No capability unseals a run.

## Evidence

The answer reports the kill as queued, not as carried out. Whether the process stopped is the host's acknowledgement, which `list_commands` reads, and the `oxagen:kill_attempted` event on the run's chain. Records from a Tacho host are `client_attested` evidence (ADR-040 section 4).
