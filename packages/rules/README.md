# @oxagen/rules

The workspace decision-rules engine and the mandate ledger. It decides, inside
the kernel's `invoke()`, whether an action runs, needs a person's approval, or
is refused, and it records what a mandate has drawn.

## Boundary

- **Owns:**
  - The rule set schema and parser (`src/schema.ts`) and the pure evaluator
    over declared rules and resolved facts (`src/evaluate.ts`).
  - The decision-rules gate the kernel calls, with its typed refusals
    (`src/gate.ts`), and the bootstrap that installs it (`src/bootstrap.ts`).
  - Committed rule set reads and the per-workspace cache (`src/rule-store.ts`).
  - Auto-approval: the evaluator, the hard floors that always need a person,
    and the path that approves a parked call as `policy:<rule id>`
    (`src/auto-approval.ts`, `src/auto-approval-path.ts`, ADR-070).
  - The mandate check for agent principals and the mandate ledger: locks,
    reservations, releases, settlements, and period keys (`src/mandates.ts`,
    `src/mandates/measures.ts`, ADR-059).
  - The `approval.requested` fan-out to everyone who may resolve an approval,
    written in the same transaction as the approval row
    (`src/approval-notify.ts`).
- **Does not own:**
  - The kernel slot the gate plugs into: [`@oxagen/oxagen`](../oxagen/README.md).
  - The mandate and approval-rule wire schemas, which contracts share:
    [`@oxagen/oxagen`](../oxagen/README.md) (`src/mandates/schemas.ts`,
    `src/approval-rules/schemas.ts`).
  - Creating an approval request and resuming a call after a person answers:
    [`@oxagen/agent`](../agent/README.md).
  - The job that expires stale approvals:
    [`@oxagen/inngest-functions`](../inngest-functions/README.md)
    (`src/functions/mandate.expiry.ts`).
  - Role-based access: [`@oxagen/iam`](../iam/README.md).
- **Depends on:**
  - `@oxagen/oxagen`: `setDecisionRulesGate`, the kernel types, and the
    `resolve_approval` contract whose roles decide who is notified.
  - `@oxagen/database`: rule sets, mandates, the mandate ledger, and approval
    rows in Postgres.
  - `@oxagen/mcp-config`: `matchGlob`, for tool-name patterns in rules and
    mandate measures.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`, `apps/mcp`,
  `@oxagen/agent`, `@oxagen/handlers`, and `@oxagen/inngest-functions`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapDecisionRulesRuntime` | injection | `packages/rules/src/bootstrap.ts` | `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, `apps/app/instrumentation.ts` |
| `createDecisionRulesGate` | adapter | `packages/rules/src/gate.ts` | Implements `DecisionRulesKernelGateFn` from `packages/oxagen/src/kernel.ts` |
| `RuleSetLoader` | port | `packages/rules/src/gate.ts` | `packages/rules/src/bootstrap.ts` passes `loadWorkspaceRuleSet` or `loadCurrentRuleSet` |
| `FactResolver` | port | `packages/rules/src/types.ts` | Not wired. Rules over `facts.*` keys load, and their conditions read an empty bag. |
| `notifyApprovalRequested` | export | `packages/rules/src/approval-notify.ts` | `packages/agent/src/runtime/approval.ts`, `packages/agent/src/runtime/external-approval.ts`, and the mandate gate in `src/mandates.ts` |

## Entry points

- `.` (`src/index.ts`): the evaluator, the gate and its errors, the rule store,
  auto-approval, the mandate ledger, measures, and the bootstrap.
- `./approval-notify` (`src/approval-notify.ts`): the approval fan-out. It is
  deliberately absent from the barrel, so there is one specifier for it.

## Rules

- Each surface calls `bootstrapDecisionRulesRuntime()` once at startup.
  Without it, every capability runs as if no rule existed.
- The gate fails open when its own rule loader fails, because a broken loader
  must not stop every agent action in the workspace. A verdict that evaluated
  is always enforced.
- The gate fails closed for an external tool call and for a call that asks for
  fresh rules (`requireFreshRules`).
- The mandate check never fails open. A consequential call with no verdict is
  refused (ADR-059).
- Every writer of an approval row calls `notifyApprovalRequested` inside the
  same transaction, so no approval exists that nobody was told about.

## Tests

```bash
pnpm --filter @oxagen/rules test:unit src/evaluate.test.ts
```

Tests sit beside their source under `src/`. The `*.pg.test.ts` files need
`DATABASE_URL` and skip without it.
