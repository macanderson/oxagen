# set_org_billing_terms

**Capability:** `set_org_billing_terms`
**Domain:** billing
**Mode:** sync
**Scope:** none (`scoped: false`; the call carries no tenant and the row is keyed on the input's `orgId`)
**Surfaces:** none
**Mutates:** yes
**Platform-operator only:** yes (`platformOnly: true`)
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The platform operator's half of the two billing-terms writes (`apps/app/ARCHITECTURE.md` §3.9 item 12, ADR-055 §5). It approves one organization for invoice billing or returns it to prepaid, and sets `invoice_gau_max` — the uninvoiced overage at which an interim invoice is cut.

Approving invoice billing is a credit decision: from then on the organization consumes governed action units without a cap and is invoiced afterwards. The customer sees the mode and the ceiling read-only on the Billing page and can change neither.

It also sets `assistant_spend_cap_cents`, the monthly cap on assistant tokens the platform key pays for (ADR-053 §3). The column defaults to 2,000 ($20 a month) and the rev1 app has no control for it, so an enterprise that prepays assistant credits needs an operator to raise or remove it. A call sets the billing mode, the cap, or both. `create_prepaid_invoice` can also set the cap when a prepaid order's credits are granted.

## Reachability

This is the first `platformOnly` capability, and three declarations carry that:

| Declaration | What it does |
|---|---|
| `platformOnly: true` | The kernel refuses the invocation, before the IAM check, unless the `CapabilityContext` carries a `platformOperator` binding minted by `createPlatformOperatorContext` (`packages/oxagen/src/platform-operator.ts`). A literal `true`, a spread copy or a JSON-shaped object is refused as a forged platform binding with a security event. This is the boundary. |
| `surfaces: []` | No API route, no MCP tool, no CLI command, no app binding. `layers` lists only `schema`, `unit` and `docs`, which is everything that exists. |
| `defaultEffect: "deny"`, `defaultRoles: {}` | No role in any organization grants it. On its own this decides nothing below enterprise — the kernel's IAM check allows every capability for a non-enterprise org — which is why the kernel check above exists. |

No surface context builder mints a binding, and a unit test on each asserts the key is absent. An arch test (`packages/oxagen/src/test/platform-operator-field.test.ts`) walks `apps/*/src`, `packages/*/src` and `tools/scripts` and fails if `platformOperator` or `createPlatformOperatorContext` appears outside `packages/oxagen` anywhere but the operator script. Together these are INV-31.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `orgId` | string | yes | uuid; the target organization |
| `approvedForInvoiceBilling` | boolean | with `invoiceGauMax` | `true` → invoice billing; `false` → prepaid |
| `invoiceGauMax` | integer | with `approvedForInvoiceBilling` | 1-100,000,000; the column's CHECK is `> 0` |
| `assistantSpendCapCents` | integer or null | no | credit cents a month, 0 or more; null removes the cap; 0 refuses every platform-paid assistant turn |

The billing mode's two fields are given together or not at all, and a call gives the mode, the cap, or both. `invoiceGauMax` is accepted with `approvedForInvoiceBilling: false` and is then inert: stored, and read by nothing.

## Output

The three terms as they stand after the call: `orgId`, `approvedForInvoiceBilling`, `invoiceGauMax`, `assistantSpendCapCents` (null is no cap). A term the call did not set is read back unchanged.

## Side effects

One upsert on `billing.org_billing_settings` per group the call sets, on `withSystemDb`, keyed on the input's `orgId`. A cap-only call writes only `assistant_spend_cap_cents` and closes no accrual. Audited twice: the handler awaits `emitSecurityEventAsync` for a `billing.plan_changed` row naming the target org, this capability and the operator run's request id (`actorUserId` is null, because an operator script has no session), and the kernel's `capability.invoke_allowed` / `invoke_denied` row is written by the emitter `pnpm billing:terms` registers before it invokes, with the target org as the row's `orgId`. The script awaits both rows before it closes the pool and exits.

Switching invoice billing off on an organization with uninvoiced overage must also close the accrual — `claimInterimInvoice` plus the settlement sequence. That lands in WL-31 with the rest of `gau_settlements` in motion.

## The one caller

```
pnpm billing:terms --org <slug> [--invoice-billing on|off --invoice-gau-max <n>] [--assistant-cap-usd <n|none>]
```

`tools/scripts/billing-terms.ts`, beside `stripe-sync.ts`, run with the production `DATABASE_URL` from Parameter Store the way `pnpm billing:stripe-sync` and `db-migrate.yml` are. It echoes the target database, resolves the organization by slug through `withSystemDb`, loads `@oxagen/handlers/register`, and invokes the capability with `{ platformOperator: createPlatformOperatorContext({ requestId }), surface: "runner", requestId }`.

`surface` there is the `CapabilityContext` field. It passes no `opts.surface`: `surfaces: []` would refuse any as `surface_denied` before the handler ran.

## Errors

| code | meaning |
|---|---|
| `authz_denied` (`CapabilityError`) | the context carries no platform-operator binding, or carries a value the kernel did not mint |
| `invalid_input` | `orgId` is not a uuid, `invoiceGauMax` is outside 1-100,000,000 or not an integer, one of the mode's two fields is given without the other, nothing is given to set, the cap is negative or fractional, or an unknown key is present |
