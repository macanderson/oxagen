# @oxagen/billing

`@oxagen/billing` decides whether an organisation may spend and records what it spent. It supplies the kernel's billing admission gate, spend-budget gate, and governed-action recorder, and it owns credits, subscriptions, the price book, and the Stripe integration behind a vendor-neutral provider port.

## Boundary

- **Owns:**
  - `bootstrapBillingRuntime()`, which installs the three kernel billing slots.
  - Governed-action units: the monthly bucket (`src/gau-bucket.ts`), accrual (`src/action-metering.ts`), reversals, and settlements (ADR-052, ADR-055).
  - The spend-budget ceiling and its running counter (`src/spend-budget-gate.ts`, `src/spend-counter.ts`, ADR-060).
  - The token meter as a priced report (`src/metering.ts`), the pre-turn credit gate for platform-funded assistant turns (`src/turn-credit-gate.ts`, ADR-053), and credit lots and grants (`src/credits.ts`, `src/grants.ts`).
  - Usage admission, settlement, and the delivery outbox for AI calls (`src/usage-outbox.ts`, ADR-134).
  - Pricing (`src/pricing.ts`), the model price book, contract terms, and plan allowances.
  - Customers, subscriptions, seats, invoices, checkout, payment methods, disputes, dunning, and Stripe webhook processing, all through the `BillingProvider` port.
  - The CLI rate card (`src/rate-card.ts`).
- **Does not own:**
  - The gate slots and the order they fire in: [`@oxagen/oxagen`](../oxagen/README.md) (`src/kernel.ts`).
  - Model calls and token counting: [`@oxagen/ai`](../ai/README.md), which calls `admitUsage` and `finalizeUsage` here.
  - The billing tables: [`@oxagen/database`](../database/README.md) (`src/schema/billing.ts`).
  - The Stripe webhook HTTP route: `apps/api/src/routes/stripe.ts`.
  - Scheduled usage delivery: [`@oxagen/inngest-functions`](../inngest-functions/README.md) (`src/functions/billing.usage-delivery.ts`).
  - Plugin entitlement: [`@oxagen/plugins`](../plugins/README.md).
- **Depends on:**
  - `@oxagen/oxagen`: the kernel setters `setBillingAdmissionGate`, `setBudgetAdmissionGate`, and `setUsageRecorder`.
  - `@oxagen/database`: `withTenantDb`, `withSystemDb`, and the billing schema.
  - `@oxagen/tenancy`: tenant scope for scoped reads and writes.
  - `@oxagen/telemetry`: ClickHouse usage rows and error capture.
  - `@oxagen/run-ledger`: step kinds for the cost rollup (`src/cost-rollup-store.ts`).
  - `@oxagen/notifications`: auto-reload, dunning, and receipt email.
  - `@oxagen/config`: env readers.
- **Used by:** `apps/api`, `apps/app`, `apps/cli`, `apps/mcp`, `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/ai`, `@oxagen/auth`, `@oxagen/handlers`, `@oxagen/iam`, `@oxagen/inngest-functions`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapBillingRuntime()` calls `setBillingAdmissionGate(assertGauAvailable)` | injection | `packages/billing/src/bootstrap.ts` | `apps/app/instrumentation.ts`, `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and `packages/agent/src/runtime/approval-resume.ts` |
| `setBudgetAdmissionGate(assertWithinSpendBudget)` | injection | `packages/billing/src/bootstrap.ts` | The same `bootstrapBillingRuntime()` call |
| `setUsageRecorder(recordGovernedAction)` | injection | `packages/billing/src/bootstrap.ts` | The same `bootstrapBillingRuntime()` call |
| `BillingProvider` | port | `packages/billing/src/provider.ts` | `billingProvider()` in `packages/billing/src/client.ts` returns the Stripe adapter wrapped in a circuit breaker |
| `StripeProvider` | adapter | `packages/billing/src/stripe-provider.ts` | Implements `BillingProvider`. `setBillingProvider` swaps it in tests |
| `admitUsage`, `finalizeUsage`, `voidUsage` | export | `packages/billing/src/usage-outbox.ts` | `packages/ai/src/record-token-usage.ts` |
| `deliverUsageOutbox` | export | `packages/billing/src/usage-outbox.ts` | `packages/inngest-functions/src/functions/billing.usage-delivery.ts` |
| `evaluateTurnCreditGate` | export | `packages/billing/src/turn-credit-gate.ts` | `packages/agent/src/runtime/assistant-turn.ts` and `packages/inngest-functions/src/lib/run-enrichment.ts` |
| `processStripeEvent`, `verifyStripeSignature` | export | `packages/billing/src/webhooks.ts` | `apps/api/src/routes/stripe.ts` |

## Entry points

- `.` (`src/index.ts`): the gates, bootstrap, metering, credits, subscriptions, the price book, and the provider.
- `./pricing` (`src/pricing.ts`): the plan and price definitions `pnpm billing:stripe-sync` reconciles into Stripe.
- `./rate-card` (`src/rate-card.ts`): model rates and `formatUsd` for `apps/cli`, without Stripe or Drizzle.

## Rules

- Admission never charges. `assertGauAvailable` reads the month bucket and billing mode, so a Stripe outage cannot make the gate fail open (ADR-055).
- Accrual fires after a successful handler, never before. The kernel calls the usage recorder only for a top-level, non-`noBillingGate` invocation that completed (ADR-052).
- The recorder resolves the organisation's terms, mode, and period itself. A caller cannot claim cheaper terms.
- The spend-budget gate fails open on a database error and denies with `BudgetExceededError` on a real breach. Surfaces map that to HTTP 402.
- A `consume_assistant_tokens` shortfall is a debt, not a write-off. `consumeCredits` with `carryShortfall` banks the unpaid whole credits in `org_billing_settings.meter_carry_micro_credits_by_reason`. `assertCanStartTurn` admits a platform-funded turn only while the balance minus `owedCredits(orgId)` is above zero, the next charge collects the debt first in its own `credit_debt` ledger row, and every grant runs `settleOwedCredits` before it writes the balance mirror. A turn on the organisation's own key debits no credits.
- Every AI provider call gets one usage admission before the provider is contacted, and settlement is idempotent on that id (ADR-134).
- Domain code calls `billingProvider()`, never the Stripe SDK. `stripeClient` is exported for `tools/scripts` Stripe sync only.
- `src/pricing.ts` is the source for Stripe products and prices. Edit it, then run `pnpm billing:stripe-sync --apply`.
- `src/rate-card.ts` mirrors the rates in `src/pricing.ts` so the CLI does not load Stripe. Change both together.
- `bootstrapBillingRuntime()` is idempotent. A surface that never calls it runs with the billing gates empty.

## Tests

```bash
pnpm --filter @oxagen/billing test:unit src/gau-bucket.test.ts
```

Never put `--` before the filename. Unit tests live beside the source in `src/`. Database-backed tests live in `integration/` and run in CI's `pipeline.yml` through `vitest.integration.config.ts`.
