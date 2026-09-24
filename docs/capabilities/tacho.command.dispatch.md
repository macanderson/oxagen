# dispatch_command

Queue a run control (Mission Control spec §7.3, §7.4, §7.6; ADR-056): `pause`, `resume`, `cancel`, `steer` or `message` for one run, for every live run of an agent, or for every live run in the workspace (`@agents`). One `tacho.control_commands` row is written per recipient run, carried by the host its session belongs to; the collector takes it on its next ingest response or command poll (`fetch_commands`) and reports what became of it. The delivery report is `list_commands`.

`steer` and `message` carry prompt content and a §7.3 delivery mode. The mode is resolved per recipient at dispatch, at or below the one requested, and only to a mode the recipient's host can carry. The hook adapter puts steering text in front of the agent at its next prompt, so `turn_boundary` is the mode every host delivers. `next_step` needs a host that advertises the `steer_next_step` bundle feature and a session whose harness carries a steer mid-turn: Claude Code or Codex, which deliver at `PostToolUse` and `Stop`. Cursor delivers at `Stop` (ADR-141) and Stella at `SessionStart`, so their steers land at the turn boundary. Without both, `next_step` and `interrupt` are recorded as `turn_boundary` with `degradedReason: no_step_carrier`. With one, `interrupt` also needs the run's model traffic to pass through the host's loopback proxy, which can cut a call in flight: the `gateway` and `contained` tiers (ADR-095). Elsewhere it lands as `next_step` with `degradedReason: harness_tier`. On a broadcast the requested mode is a ceiling. Both modes are recorded, and the report shows the achieved one. Steering text is evidence, quoted and cited; Oxagen never executes it.

A new command supersedes an earlier `queued` command of the same kind on the same run: the earlier row becomes `cancelled` with `superseded_by:<id>`.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/commands`
- MCP: `dispatch_command`
- Authentication: session or API key; the handler requires org Owner or Admin, or workspace Owner or Member on the workspace the call is scoped to, of the signed-in user or the key's creator (`assertOrgRole`, `resolveActingUserId`, INV-29), and records that user as the issuer; a key with no recorded creator is refused `forbidden / no_principal` — the kernel's IAM check allows everything for a non-enterprise organisation
- App: `/[org]/[ws]/runs/[run]` draws Pause, Resume, Steer and Cancel on a live wrapped run, and `/[org]/[ws]` (Fleet) draws Pause, Resume and Cancel on a live wrapped run's row. Steer stays on the run page, where its text and its delivery mode have room. A run that is not live draws no controls; an `observe`-tier wrapped run and a viewer the handler would refuse each draw the recorded reason in their place, so nobody is sent to a refusal they could have read on the page
- Capability name: `dispatch_command`
- Not billed (`noBillingGate: true`): a lapsed bucket must never leave an agent unstoppable. IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `target` | object | yes | `{ kind: "run", id }` with an `arun_…` or `tse_…` id; `{ kind: "agent", id }` with the agent key `list_runs` reports; `{ kind: "workspace", id }` with the caller's workspace id |
| `command` | enum | yes | `pause`, `resume`, `cancel`, `steer`, `message` |
| `payload` | object | for `steer` and `message` | `{ text (1–16384 chars), requestedMode }`; refused on the other commands |
| `payload.requestedMode` | enum | no | `next_step` (default), `interrupt`, `turn_boundary` |
| `reason` | string | no | 1–512 chars; read by the model on resume, shown on the pause banner |
| `expiresInMs` | integer | no | 10 000–86 400 000, default 3 600 000 |

## Output

| Field | Type | Description |
|---|---|---|
| `commandIds` | string[] | one `tcm_…` id per recipient run, in the order written; empty for a broadcast that reached no live run |

## Recipients and refusals

- A direct target that cannot receive is refused, never queued (§7.3). The reason is `commandBlockOf`'s, the rule `list_runs` reports on each row as `commandBlock`: a sealed run is `conflict` / `run_sealed`; a session with no enrolled host is `conflict` / `no_host`; a host whose enrollment was revoked is `conflict` / `host_revoked`; a host that has not polled for five minutes is `conflict` / `host_offline`. The enforcement tier is not a reason: an `observe`-tier run whose host is polling takes pause, resume, steer and cancel like any other (ADR-163). A ledger run (`arun_…`) refuses steering with `conflict` / `no_connection_point`. Its pause and resume commands fence evidence ingress at the next batch boundary. Cancel revokes the run credentials and permanently fences appends. Applied command receipts describe ingress state, not external process state.
- A broadcast reaches every live root session in the workspace (or the agent's). A recipient its host cannot reach is recorded as `failed` with the reason in `outcome_detail` (`no_host`, `host_revoked`, `host_offline`) so the report is complete (§7.6). Sealed runs are not live and are not enumerated.
- `not_found`: a run id neither store holds in the caller's workspace, or a workspace id other than the caller's.
- `forbidden`: the actor holds none of org Owner, org Admin, workspace Owner or workspace Member.

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): the hook adapter denies at the harness, never at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation, and the mode shown is the one recorded as achieved.

## Ledger ingress controls

A ledger run shows Pause or Resume according to its recorded ingress state, plus Cancel. Pause refuses new evidence batches and attempt admission under the same run lock used by ingestion. Resume clears only the pause fence. It cannot reverse cancellation or revive a revoked credential. Credentials can expire while paused, so a producer may need an operator to issue a fresh credential after resume. Command receipts retain the reason and distinguish `ledger_ingress_paused`, `ledger_ingress_resumed`, and `ledger_ingress_revoked`. No command claims the external process stopped or received a model message.
