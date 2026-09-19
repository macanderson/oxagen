# ADR-109: A resolved approval is read back through a sibling capability, not the security event stream

## Status

Accepted

## Context

`autoApprovePath` (`packages/rules/src/auto-approval-path.ts`) writes a full
approval row for every call a decision rule releases without a person:
`resolution: "approved"`, `resolvedByPolicy`, `autoRuleId`, `ruleIds`,
`inputDigest`, `resolvedAt`. That row is the receipt. It says which rule
released which call, on whose authority, and against which input.

Nothing could read it back. `list_approvals` filters `resolution IS NULL`, so
a row resolved the instant it is written never appears there. No other
capability, route, tool, or page listed resolved approvals at all.
`get_auto_eligibility` reads the eligibility recorded on one approval row by
id, but no caller could obtain an id for an auto-approved call: the insert
that writes the row discards the id Postgres generates. The Codex review on
#3118 found this at `auto-approval-path.ts:98`; #3153 is the issue that
carries the fix.

Two shapes were on the table.

**Shape 1: a read path for resolved approvals.** Either widen `list_approvals`
with a resolution filter, or add a sibling capability. Both need the full
chain: contract, barrel index, handler, `register.ts`, API route, MCP tool,
CLI, and app UI.

**Shape 2: link through the security event stream.** `emitAutoApproved`
already sends `approval.auto_approved` to `@oxagen/telemetry`'s security event
stream on every auto-approval. Adding a resource-id field to
`SecurityEventInput` (`packages/telemetry/src/security.ts:46`) would let that
event carry the approval's id, and a reader could look the event up. This
touches `@oxagen/telemetry`, `@oxagen/database`, the security-events table,
and needs a migration, and it decides the shape of every security event this
platform emits, not only this one: `SecurityEventInput`'s six fields (event
type, actor, org, workspace, capability, outcome, ip, user agent, request id)
are a closed audit-log shape, and `requestId` is documented as the HTTP
correlation key, the wrong place for an approval id even before a new field is
added.

## Decision

**A resolved approval is read back through `list_resolved_approvals`, a
sibling of `list_approvals` that lists the workspace's resolved approvals,
most recently resolved first, cursor-paged, optionally narrowed to one run or
a resolved-at time range** (`packages/oxagen/src/contracts/agent.approval.list_resolved.ts`).
`SecurityEventInput` is unchanged.

A resolved approval is a first-class, structured record with its own
lifecycle (pending, then approved, denied, or expired), its own foreign keys
(a run, a mandate, a requester), and its own query shape (by workspace, by
run, by time range, by id). `agent.approval_requests` is already that record.
A capability reading it back with a `resolution IS NOT NULL` filter is the
same shape `list_approvals` already uses for the pending half, proven against
the same table, the same RLS, and the same public-id convention. Extending
`SecurityEventInput` to carry a resource id would make the audit-log stream
double as a structured-lookup index for every domain that wants one back,
which is what it is not for: the security-events table is an append-only
audit trail of *that an event happened*, not a queryable projection of *what
the record now says*. `emitAutoApproved`'s event stays exactly what it is,
the audit trail's evidence that a policy decision happened, and the new
capability is the query a person or an agent actually runs to answer "what
did the rule let through, and what does the row say now."

A new capability rather than widening `list_approvals` with a resolution
filter, for three reasons. First, the two reads have materially different
shapes: a pending row's page is ordered soonest-expiry-first because a caller
is watching a clock, and a resolved row's page is ordered
most-recently-resolved-first because a caller is watching a history. One
`orderBy` cannot serve both without a branch inside the handler that the
contract's input would have to expose. Second, a resolved row carries fields
a pending row structurally cannot (`resolvedAt`, `resolution`, `resolvedBy`,
`autoRuleId`) and a pending row's `autoEligibility` line means something
different on a resolved item (the evaluation that governed the release, not a
forecast of what would happen); folding both into one polymorphic output
schema would make every consumer branch on `resolution === null` to know
which fields are meaningful, exactly the ambiguity a typed capability contract
exists to remove. Third, `list_approvals`' own contract, at
`packages/oxagen/src/contracts/agent.approval.list.ts`, documents itself as
"the workspace's pending tool-call approvals" and is read by the Fleet
approvals panel and the Run approvals strip on that promise; changing its
output shape under those callers is a breaking change to an existing,
UI-bound capability for a caller that wants the opposite half.

## Consequences

- `get_auto_eligibility` now has a caller-reachable path to the id it takes:
  `list_resolved_approvals` returns `id` on every item, including a row
  `autoApprovePath` resolved with no person.
- The receipt `autoApprovePath` writes is no longer write-only. An auditor
  asking "which rule released this call, and when" has a query that answers
  it, on every surface a human or an agent operates from: API, MCP, CLI, and
  the Run page's Approvals tab (bound in `apps/app/capability-ui-map.json`).
- `SecurityEventInput` and the security-events table are unchanged: no
  migration, no new field, no widening of the audit-log shape. The event
  `emitAutoApproved` sends stays what it always was.
- Two contracts now share one table's read surface (`list_approvals` for
  `resolution IS NULL`, `list_resolved_approvals` for
  `resolution IS NOT NULL`), each with its own ordering, its own fields, and
  its own callers. Both are `noBillingGate: true` console reads, consistent
  with ADR-052 exclusion 2.
- `autoApprovePath`'s insert now also `.returning()`s the row's public id and
  logs it, so the id that used to disappear is visible in the write-path log
  too, not only reachable through the new read.

## Alternatives considered

- **Widen `list_approvals` with a `resolution` filter or flag.** Rejected:
  the two reads have different default ordering, different meaningful
  fields, and different callers with an existing UI contract on the current
  shape; folding them together trades one clear capability for one
  ambiguous one.
- **Add a resource-id field to `SecurityEventInput`.** Rejected: it repurposes
  an append-only audit-log input as a structured-lookup index, decides the
  shape of every security event this platform emits rather than only this
  one, and needs a migration for a problem a read capability against the
  record that already exists solves without one.
- **Leave the id write-only and make `get_auto_eligibility` discoverable some
  other way** (for example, joining through the run transcript). Rejected:
  a call parked outside any run records no run, so a run-keyed path cannot
  reach every auto-approved row, and the issue explicitly asks for a caller
  to be able to fetch a resolved approval by id and list them for an org and
  workspace over a time range, which only a direct read of the approval
  ledger answers in every case.
