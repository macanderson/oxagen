# ADR-059: Mandates: consequence roles, the decision seam and the ledger

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** platform
- **Refines:** ADR-052 (a mandate write is a settings write on an identity,
  outside the metering surface), ADR-057 (the agent identity a mandate binds
  to is the agent's delegated `iam.principals` row).
- **Related:** `apps/app/ARCHITECTURE.md` §1.5, §3.2, INV-09, INV-10,
  INV-29, INV-30; the Mission Control spec §6.9, §6.10, App. A.5, App. A.6,
  App. E; GitHub issue #2957 and its scope note of 2026-09-14;
  `packages/oxagen/src/mandates/schemas.ts`,
  `packages/oxagen/src/contracts/mandate.{grant,request,list,get,revoke,limits.update}.ts`,
  `packages/rules/src/mandates.ts`, `packages/rules/src/gate.ts`,
  `packages/database/src/schema/tools.ts`,
  `packages/database/atlas/migrations/20260915100000_mandates_and_ledger.sql`.

## Context

Spec §6.9 part 3 defines a mandate: bounded, expiring authority for a
consequence, granted by a human holding the role the workspace names for
that consequence, to one agent, within limits over the tool's declared
measures, with a Postgres ledger of reservations, settlements and
releases. Issue #2957 names three decisions the slice cannot be built
without and records a recommendation for each. The maintainer's scope note
of 2026-09-14 cuts two-person mandates and every approval-of-approval flow
from this release. The tree holds no mandate table, no consequence tag on a
tool, and no place a call's measure is read.

## Decision

### 1. Consequence roles are a workspace column with defaults in code

`workspace.workspaces.consequence_roles jsonb NOT NULL DEFAULT '{}'` maps a
consequence tag to the IAM org role names that may grant, change or revoke
a mandate for it. `DEFAULT_CONSEQUENCE_ROLES` in
`@oxagen/oxagen/mandates/schemas` is the map applied when the column has no
entry for a tag:

| tag | roles |
|---|---|
| `moves_money`, `changes_entitlement` | Owner, Billing |
| `destroys_data`, `alters_production`, `communicates_externally` | Owner, Admin |
| `changes_access` | Owner, Admin, Compliance |
| any tag the customer defines | Owner, Admin |

The spec's "org.billing", "platform" and "security" offices land on the
six roles the tree seeds (`Owner`, `Admin`, `Member`, `Billing`,
`Compliance`, `Viewer`): finance is `Billing`, the platform team is `Admin`,
security is `Compliance`. `update_workspace_settings` writes the overrides
and `get_workspace_settings` returns the effective map, so the Tools page
edits it through the contract that already owns workspace settings. A
granter must hold a named role for every tag on the mandate; a mandate over
two consequences needs authority over both.

### 2. Two-person mandates are not in this release

No `two_person` or `second_approver` column, no `accept_mandate` contract,
no `pending_second` state. The scope note of 2026-09-14 cuts them; the
columns and the state return with the lane that builds them.

### 3. Reconciliation ships with `spend-findings-reconciliation`

Every settlement records `external_effect_id`, read from the tool's output
by the tool version's declared `effect_id_path`. The matcher that compares
settlements to a connection's own statement is that lane's; this one
records the key it will join on.

### 4. The decision seam is the kernel's decision gate

The mandate check lives in `packages/rules` beside the decision rules,
because both answer the same question at the same place: may this call
proceed. The kernel hands the gate the principal it resolved, and the gate
runs the mandate check only for an agent principal (`kind: "agent"`) — a
human acting under their own role needs no mandate, and the spec grants
mandates to agents. The gate looks the capability up as a tool in the
workspace registry (`agent.tools.slug` equals the capability name, the same
identity `tool-projection.ts` uses) and reads the version's
`consequence_tags`, `measures` and `effect_id_path`. A tool with no
consequence tag yields no opinion. A tagged tool is decided in this order:

1. no active mandate of the agent covers every tag and matches the tool →
   deny, reason `no_mandate`, ledger unchanged (§6.9 part 3);
2. a target measure outside the mandate's allow list, or on its deny list →
   deny, reason `target_denied`;
3. a measure over `per_call` or over the period's remaining authority →
   deny, reason `over_limit`; the mandate stays as it was;
4. the tool carries a tag in `always_human_for`, or a measure exceeds
   `human_above` → the reservation is written, an
   `agent.approval_requests` row is inserted carrying `mandate_id`,
   `tool_call_id`, `rule_ids` and `input_digest`, and the call is refused
   as pending approval with that row's id. A retry of the same digest by
   the same agent within the approval's window, after a person approved it,
   proceeds on the held reservation and marks the row used
   (`token_used_at`); the approval is single-use;
5. otherwise the reservation is written and the call proceeds.

The gate returns a settlement the kernel applies after the handler: the
output validated → `settle` with the effect id read from the output; the
handler threw or the output failed validation → `release`. The kernel change
is the principal on the gate's arguments and the two post-handler calls;
the kernel still imports nothing from `@oxagen/rules`.

`resolve_approval` on a row carrying a mandate releases the reservation on
`denied` and leaves it held on `approved` — the effect has not happened at
approval time, so nothing settles there; the retry's receipt settles. The
output reports `mandate: { mandateId, reserved, outcome }` with `outcome`
`held` or `released`.

Calls Oxagen only observes — frames a Tacho host ingests after the fact —
are not gated here. The Tacho incident kind `mandate_exception` is where the
reconciliation lane records an observed effect with no settlement.

### 5. The ledger is movements on remaining authority, one row per measure

`tools.mandate_ledger` is append-only (SELECT and INSERT for the application
role). A row is one movement for one measure of one mandate in one period
(`period_key`: `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM` in UTC by the limit's
`period`). `reserve` lowers remaining by the value, `release` raises it,
`settle` leaves it unchanged and converts the reservation to a settlement.
`balance_after` is the remaining authority after the row; a period with no
rows starts at `per_period`. Remaining authority is read from the ledger's
last `balance_after`, never computed elsewhere (INV-10). Every write runs
in one transaction that first takes `SELECT … FOR UPDATE` on the mandate
row, so concurrent calls serialise and two cannot both fit under one
remaining limit. The unique index `(mandate_id, tool_call_id, measure,
kind)` is the database backstop, as `(bucket_id, kind, seq)` is for GAU
settlements (INV-30). The issue's `(mandate_id, tool_call_id, kind)` is
widened by `measure` because one call reserves one row per limited measure.

### 6. Measures are declared on the tool version

`agent.tool_versions` gains `consequence_tags text[]`, `measures jsonb` and
`effect_id_path text`, written by `publish_tool_declaration` from three new
optional inputs. A measure is `{ path, type, unit, scale? }`: `path` is a
dot path into the call's input, `type` is `amount`, `count` or `text`,
`unit` is a currency code or a unit name, and `scale` is the number of
decimal places the tool uses for an amount (default 2). An amount is
converted to micros with string arithmetic, never a float. `calls` is the
one built-in measure: value 1 per call, no path. Values on the wire are
integer strings — micros for a currency, whole units otherwise (INV-09).

`grant_mandate` resolves the mandate's tool patterns against the workspace
registry; a pattern that matches no declared tool, or a matched tool whose
version declares no measure for a limit the mandate names, is refused
(`invalid_input`, reasons `no_tool_matches` and `measure_not_declared`) —
denied by construction (§6.9 rule 1).

### 7. Expiry is an hourly job

`mandate/expiry` (`packages/inngest-functions`) flips `active` mandates past
`valid_to` to `expired`, releases reservations held by approval requests
that expired unresolved, and emits `mandate.expired`. Grant, revoke and a
limits change emit `mandate.granted`, `mandate.revoked` and
`mandate.limits_changed`; a refusal by the gate emits `mandate.exception`.

## Consequences

- The mandate check binds every agent-principal invocation of a tagged tool
  through the kernel. When the agent-credential path at the API resolves an
  agent principal (the #2956 lane's credential), the check applies to it
  with no further change.
- A tool that is not declared in the workspace registry carries no tag and
  is not mandate-gated; declaring it is how a workspace puts it under a
  mandate. This is the same registry the Tools page reviews.
- `suspended` (spec A.5) has no producer in this release and is not in the
  status CHECK; `taint_sources` (spec A.6) has no producer and is not on
  `approval_requests`. Both return with their producers.
