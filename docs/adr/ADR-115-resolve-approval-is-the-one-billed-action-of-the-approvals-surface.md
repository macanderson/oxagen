# ADR-115: `resolve_approval` is the one billed action of the approvals surface

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** kernel, app
- **Related:** ADR-052 (the metering surface and its exclusions); ADR-055 §1.5;
  ADR-059 (mandates, the ledger, the consequence roles that gate a grant);
  ADR-070 (the recorded auto-approval evaluation); issue #2950 decision 1;
  `apps/app/ARCHITECTURE.md` §1.5; `docs/capabilities/agent.approval.resolve.md`
- **Delivered by:** `agentApprovalResolve` (`packages/oxagen/src/contracts/agent.approval.resolve.ts`),
  which carries no `noBillingGate`, and `kernelWrite`
  (`apps/app/src/server/kernel.ts`), the app's only write path to it

## Context

Issue #2950 left one decision open for the maintainer: ratify `resolve_approval`
as the governed action of rev1, with console reads and membership writes free of
charge, or bill something else. The question blocked the approvals surface,
because a page that approves a tool call has to know whether opening it costs
anything.

Three facts already in the tree answer it.

`list_approvals` and `get_auto_eligibility` both declare `noBillingGate: true`
(ADR-052 exclusion 2, INV-28): drawing the queue, polling it, and reading what
the auto-approval clause said about one call meter nothing and lock nobody out.
`apps/app/src/server/kernel.test.ts` pins that pairing directly. It reads a
`noBillingGate` contract for an organization whose grant bucket is empty and
gets the rows back, then calls `resolve_approval` through the same gate and gets
`{ reason: "exhausted", code: "gau_exhausted" }`.

`resolve_approval` carries no `noBillingGate`, so the billing admission gate
fires on it, after IAM and before the handler.

The handler refuses an unknown, expired, or already resolved id with
`HandlerError { code: "conflict", reason: "approval_expired" }` before the
recorder runs, so a decision that matched no row is never billed (#2906).

## Decision

**`resolve_approval` is the one billed action of the approvals surface.** Every
other capability the surface reads through stays outside the metering surface.

- `resolve_approval` keeps no `noBillingGate`. A human decision on a parked tool
  call is the governed act ADR-052 bills, and ADR-055 §1.5 names the model.
- `list_approvals`, `list_resolved_approvals`, and `get_auto_eligibility` keep
  `noBillingGate: true`. Drawing the queue, reading one call's recorded
  evaluation, and reading the resolved ledger are console reads.
- A decision that matches no pending row is refused before the recorder, so it
  bills nothing. The output enum holds only the two decisions a caller can make.
- The app reaches the capability through `kernelWrite`
  (`apps/app/src/server/kernel.ts`) and nowhere else. The seam is where the
  admission gate, the tenant scope, and the output parse all sit, so a surface
  that skipped it would skip the billing this ADR ratifies.

## Consequences

An operator who has exhausted their grant can still read the queue, open a card,
and see the four hops and the recorded eligibility. The decision itself answers
`exhausted` with the code the gate raised (`gau_exhausted`,
`billing_suspended`, or `budget_exceeded`), and the dialog says which and links
to billing (INV-14). Nothing about the queue disappears, because hiding the
record of what an agent asked for is not a billing behavior.

Adding a write to this surface means answering this ADR: either it is a governed
act and it meters, or it is console upkeep and it declares `noBillingGate: true`
with the reason written down.
