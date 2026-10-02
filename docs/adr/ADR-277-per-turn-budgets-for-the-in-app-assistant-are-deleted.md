# ADR-277: Per-turn budgets for the in-app assistant are deleted

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** billing
- **Decided by:** the maintainer, 2026-10-02, in the ADR-235 amendment of that
  date: "The Oxagen app never controls the assistant."
- **Related:** issue #5102, ADR-235 (amended 2026-10-01 and 2026-10-02), #4935,
  #5101, `DEREGISTERED.md` §13, ADR-081.

## Context

Four capabilities let a customer set a dollar budget for one turn of Oxagen's
in-app assistant:

- `get_user_budget` and `update_user_budget` read and wrote a person's own
  per-turn budget. It lived in four `per_turn_budget_*` columns on
  `auth.user_preferences`.
- `get_budget_policy` and `update_budget_policy` read and wrote a workspace's
  per-turn policy. An Owner or Admin set it as a default for members or as a
  ceiling over them. It lived in `workspace.workspace_budget_policy`.

#4935 stopped the assistant's turn from reading either budget (ADR-235,
item 10). The four capabilities stayed on the API, MCP, and agent surfaces, so
a customer could still store a budget that nothing enforced. On 2026-10-02 the
maintainer ruled that no customer role gets a budget, cap, toggle, switch,
setting, or approval control over the assistant, on any app page or API. These
four capabilities are such controls.

`DEREGISTERED.md` §1 says a feature leaves the tree only under an ADR that
names it. This is that ADR.

## Decision

Delete the four capabilities and their storage.

Delete these files:

- the contracts `packages/oxagen/src/contracts/budget.policy.read.ts`,
  `budget.policy.write.ts`, `workspace.budget_policy.read.ts`, and
  `workspace.budget_policy.write.ts`, with their tests and barrel entries;
- the handlers of the same names under `packages/handlers/src/`, with their
  tests and their registrations in `register.ts`;
- the API routes of the same names under `apps/api/src/routes/v1/`, with their
  tests, their mounts in `apps/api/src/app.ts` (`/v1/user/budget/read`,
  `/v1/user/budget/write`, and `/v1/:org_slug/:workspace_slug/workspace/budget-policy`),
  and their rows in `thin-capability-routes.test.ts` and
  `user-global-routes.test.ts`;
- the MCP tools of the same names under `apps/mcp/src/tools/`;
- the capability docs `docs/capabilities/budget.policy.read.md`,
  `budget.policy.write.md`, `workspace.budget_policy.read.md`, and
  `workspace.budget_policy.write.md`, and their generated schemas;
- in `apps/app_deprecated`, the composer's per-turn budget control
  (`budget-control.tsx`, `budget-actions.ts`) and the budget form on the
  agent defaults page (`budget-form.tsx`, `budget-action.ts` and its test).

Drop the storage in one migration, `20261002233000_drop_assistant_turn_budgets.sql`:
the `workspace.workspace_budget_policy` table and the four `per_turn_budget_*`
columns on `auth.user_preferences`. The four handlers were the only readers.

Change these to match:

- `packages/billing/src/turn-budget-policy.ts` keeps only
  `requestTurnBudgetSchema`. The REST chat route still accepts a `budget` field
  and ignores it (ADR-235 item 10), and the schema still answers 400 for a
  malformed one. The saved-default and workspace-governance resolvers are gone.
- `packages/billing/src/turn-budget.ts` loses the workspace governance merge
  (`resolveEffectiveTurnBudget`, `GovernedBudget`, `strictestMode`).
- The deprecated app's chat route accepts the `budget` field and ignores it, as
  the REST route does. It builds no budget guard and sends no `budget-tick` or
  `budget-notice` event. The deprecated app's client sends no `budget` field,
  and its session settings, Agent defaults Budget tab, and approval card for a
  budget pause are gone.
- The REST chat route's event type drops the `budget-notice` variant, which
  nothing emitted.
- The `budget.set` permission in `permission-catalog.ts` names only
  `get_spend_budget` and `set_spend_budget`.
- The v2 design contracts stop absorbing the four names. `set_budget` has no
  `turn` period and no `onBreach` or `graceOveragePct` field, because those
  only described a turn. `update_workspace` has no `budget` block. The
  fixtures `matrix.json` and `full-matrix.json` drop the four names. Appendix E
  in `oxageninc/roadmap` still lists them and should drop them too.
- The current app's stream client stops filtering a `budget.turn.continue`
  approval. Nothing emits one now.

Keep these:

- `createTurnBudgetGuard` and `evaluateTurnBudget` in `@oxagen/billing`, and
  the `budgetGuard` input on `runGovernedTurn`. No production caller passes a
  guard after this change. The seam stays for a governed agent's turn.
- `iam.role_grants` rows that name the four capabilities. The resolver skips a
  grant for a capability that is not registered
  (`packages/iam/src/delegation-ceiling.ts`), so the rows grant nothing.
- The names in ADRs, audits, `docs/specs/adr025-naming-mapping.md`, and
  `tools/scripts/adr025-name-map.mjs`. They record history.

## Consequences

- No API route, MCP tool, or agent tool offers a per-turn budget for the
  assistant. A caller of a removed route gets 404, and an MCP client no longer
  lists the four tools. This is a breaking change for any caller that used them.
- Stored budgets are deleted. They governed nothing after #4935.
- Nothing else changes. The credit gate, the billing admission gate, the
  assistant spend cap, and the period spend ceilings (`get_spend_budget`,
  `set_spend_budget`) never read these values. The Spend page still shows the
  assistant's spend as its own line (#5101). The wrapped-session policy
  (`tacho_session_policy`) is a different setting and stays.

## Alternatives

- **De-register and keep the files.** Rejected. The ruling covers every entry
  point, and the stored values describe a control nothing enforces. Keeping
  the code would keep paying `DEREGISTERED.md`'s rent for a feature the
  maintainer ruled out.
- **Keep the storage and drop only the capabilities.** Rejected. Nothing reads
  the table or the columns, so they would only hold dead values.
- **Delete the turn-budget guard too.** Deferred. `runGovernedTurn` declares
  the `budgetGuard` seam, and removing it is a change to governed agents, not
  to the assistant.
