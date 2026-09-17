---
name: oxagen-testing
description: Test conventions in the Oxagen monorepo — co-located *.test.ts files, the vitest coverage-threshold ratchet (never lower, cap 90, keep 2.5% headroom), the three-spec e2e rule under apps/app/e2e, and the hard rule to only run narrow, targeted test commands. Use when writing tests, touching a vitest.config.ts, or deciding what to run after a code change.
---

# Oxagen testing conventions

## NEVER run all tests — this is a hard rule for every agent and subagent

Do not run `pnpm test`, `turbo run test`, a whole-repo `pnpm gate`, or any all-package/all-file suite as a mid-task check. Run **only** the specific test(s) obviously implicated by the files you changed — map each changed file to its nearest test and run just that file or that one package's `test:unit`:

```bash
pnpm --filter @oxagen/billing test:unit grants.test.ts

# NOT `test:unit -- grants.test.ts` — the `--` makes vitest ignore the
# filter and run the whole package. `exec vitest run src/grants.test.ts`
# is the unambiguous alternative.
```

The full gate runs in CI on every push and PR — that is the authoritative gate, not a local laptop run. `pnpm gate` (lint + typecheck + coverage + tests + builds + migrations) is a **pre-merge** check run once, by the session that owns the branch, when a body of work is finished — not a per-commit habit.

**Turbo quirk:** `turbo run test` halts on the first failing package's coverage, masking other failures. Use `turbo run test:coverage --continue` if you genuinely need to see every package's failures in one pass (still not a mid-task habit).

## Location — co-located, not `__tests__/`

`*.test.ts` / `*.test.tsx` next to the source file is the dominant convention (~98% of ~1650 test files sampled). `__tests__/` directories are the rare, deliberate exception for grouped/integration suites where no single source file is the natural home (e.g. `packages/database/src/__tests__/schema-append-only.test.ts`, `packages/handlers/src/__tests__/iam-schema.test.ts`). Default to co-location; reach for `__tests__/` only for genuinely cross-file suites.

## Vitest config + the coverage ratchet

One `vitest.config.ts` per package/app, with `coverage.thresholds` as the enforced gate. Real example, `packages/ai/vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    clearMocks: true, environment: "node", globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8", reporter: ["text", "lcov"],
      // OXA-1898: lines/statements raised to the 85% gate (measured 91.3).
      // branches/functions left at prior floors (measured 84.1 / 81.8).
      thresholds: { lines: 85, branches: 79, functions: 63, statements: 85 },
    },
  },
});
```

**Ratchet rules — never violate these when bumping a threshold:**
- Thresholds only ever go **up**, never down, and are capped at **90** — once a metric is at or above 90%, its floor is 90 and stays there.
- When new tested code raises measured coverage, bump the threshold only up to `floor(current coverage − 2.5)` — the gate must always keep **at least 2.5% headroom** below actual coverage, so CI doesn't fail on environment noise from a razor-thin gate.
- Cite the justification in a comment on the bump, exactly like the `OXA-1898` example above: the Linear ticket + the measured before/after numbers. This makes every ratchet bump auditable in diff history, not just a stated policy.
- New code requires new tests before the commit lands — route handlers, contracts, utilities, all of it.

## E2E conventions (`apps/app/e2e/`)

`apps/app/e2e` holds exactly three specs and gains no fourth (ARCHITECTURE.md §6.3):

- **`login.spec.ts`** — the sign-in journey. The proxy gates an anonymous visit, the seeded owner signs in on a production build, and the storage state the other two projects run on is saved.
- **`pay.spec.ts`** — a real Stripe Checkout session for a GAU purchase. The only check that catches a price archived out from under `billing.plans`. Skips when `STRIPE_E2E` is not `"1"` (a fork PR has no test key).
- **`page-load.spec.ts`** — walks `e2e/routes.ts`, the rev1 route table, and asserts each surface answers 200, does not redirect, carries its own catalog title, and logs no console error.

Everything else — a form, a dialog, a permission refusal, an empty state — is proven by a component test beside the component and a unit test beside the action. That is the trade: e2e is the slowest and flakiest evidence in the repo, so it is spent on the three journeys that cross a process boundary no unit test can.

No screenshots. `playwright.config.ts` sets `trace: "retain-on-failure"`, and the trace is the artifact when a spec fails.

## Gate before marking a PR ready

1. `pnpm gate` — lint (`--max-warnings 0`), typecheck, coverage, tests, builds, migrations, all green.
2. Dispatch the `test-completeness-judge` skill/agent before committing a finished body of work — re-run until approved.
3. A changed user-facing flow is proven by a component test and an action unit test. Touch the three e2e specs only when the change alters sign-in, payment, or the rev1 route table (`apps/app/e2e/routes.ts`).

## Violations to avoid

- Running `pnpm test`, `turbo run test`, or `pnpm gate` mid-task as a "let me just check" — always scope to the one file/package implicated by the change.
- Lowering a coverage threshold to make a failing gate pass instead of adding tests.
- Bumping a threshold with zero headroom (i.e. setting it equal to or above measured coverage) — CI will flake on the next run.
- Bumping a threshold past 90.
- Adding new logic (route, contract, utility) with no co-located test.
- Adding a fourth spec to `apps/app/e2e` instead of a component test.
- Shipping a UI-facing change with neither a component test nor a runtime artifact under `verifications/<session>/`.
- Creating a new `__tests__/` directory for a test that has one obvious source-file home — co-locate instead.
