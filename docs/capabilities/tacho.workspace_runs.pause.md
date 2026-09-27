# pause_workspace_runs

Pause every live wrapped run in the workspace as one governed decision (#3862). The handler queues one `pause` per live run whose host can take it, writes a `failed` row for each live run no host can reach, and records one `tacho.workspace_runs_paused` security event for the decision. The answer is a receipt: how many runs took the pause, their command ids, and each skipped run with its reason.

`dispatch_command` with target `{ kind: "workspace" }` queues the same pauses. Use this capability when the decision needs its narrower roles, a person's approval before the in-app agent acts, a receipt that separates queued runs from skipped ones, or one audit row that carries the counts. The ⌘K command menu calls this one for those reasons.

**Surfaces:** api, mcp, agent, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/commands/pause-workspace`, answering `201` with the receipt
- MCP: `pause_workspace_runs`
- CLI: `oxagen run pause-all --reason <text> [--json]`
- Agent: on the in-app agent's belt, parked for a person's approval (`requiresApproval: true`, risk `high`)
- App: every workspace page. ⌘K lists "Pause every live run in this workspace", which opens a dialog that asks for the reason, calls this capability through the kernel seam, and shows the receipt (`apps/app/src/features/shell/pause-workspace-dialog.tsx`)
- Authentication: session or API key. The handler requires org Owner or Admin, or workspace Owner on the workspace the call is scoped to, of the signed-in user or the key's creator (`assertOrgRole`, `resolveActingUserId`, INV-29). A workspace Member is refused `forbidden / org_role_required`. A key with no recorded creator is refused `forbidden / no_principal`.
- Capability name: `pause_workspace_runs`
- Not billed (`noBillingGate: true`): a lapsed bucket must never leave an agent unstoppable. IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `reason` | string | yes | 1 to 512 characters. Recorded on every command row and on the audit event. Each run reads it on resume. |

The input names no workspace. The workspace is the one the call is scoped to.

## Output

| Field | Type | Description |
|---|---|---|
| `queued` | integer | How many runs took the pause. Equal to the length of `commandIds`. |
| `commandIds` | string[] | The `tcm_…` ids of the queued rows only, in the order written. Unlike `dispatch_command`, no failed row is listed here. |
| `skipped` | object[] | Each live run no host could reach: `runId`, `agentKey`, `reason` (`run_sealed`, `no_host`, `host_revoked` or `host_offline`), and `commandId`, the `failed` row written for it. |

## Which runs are paused

- Every live root session in the workspace is addressed. A child session gets no row of its own. The command goes to its root session.
- A run whose host is enrolled and has polled in the last five minutes takes the pause, whatever its enforcement tier. An `observe`-tier run is paused too (ADR-163).
- A run `commandBlockOf` calls unreachable is skipped and recorded as `failed` with the reason in `outcome_detail`, so `list_commands` names it. The reason is the one `list_runs` reports on the row as `commandBlock`.
- A sealed session, and one the control plane closed for silence, is not live and is not addressed.
- Ledger runs (`arun_…`) are not paused. Pause one from its row on Fleet or with `dispatch_command`.
- A new pause supersedes an earlier `queued` pause on the same run: the earlier row becomes `cancelled` with `superseded_by:<id>`.
- The pause is queued, not applied. Each run stops at the next boundary its harness reaches after its host collects the command, and `list_commands` reports what became of it.

## Audit

One `tacho.workspace_runs_paused` row per call, written in the same transaction as the command rows, with outcome `success`. Its `detail` holds the reason, `queued`, `commandIds`, and `skipped` as `{ runId, reason }`. A workspace with no live run still records the decision, with `queued: 0`.

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4). The receipt says a pause was queued, not that an agent stopped.
