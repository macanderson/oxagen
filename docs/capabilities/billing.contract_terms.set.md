# set_contract_terms

**Capability:** `set_contract_terms`
**Domain:** billing
**Mode:** sync
**Scope:** none (`scoped: false`; the call carries no tenant and the row is keyed on the input's `orgId`)
**Surfaces:** none
**Mutates:** yes
**Platform-operator only:** yes (`platformOnly: true`)
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

Record the governed-action terms an enterprise signed: the agreement reference, the currency, the rate per governed action unit (GAU), the block size units are sold in, and the units included each month (ADR-055 §2). Before this capability, `billing.contract_terms` was written by hand in SQL.

The reader, `resolveContractTerms` in `packages/billing/src/contract-terms.ts`, prefers the negotiated row in force over the published tier. From `effectiveFrom` on, these figures price the admission gate, the recorder, every settlement invoice, and the default rate of a prepaid order. The org's current month bucket keeps the included units it was created with. The next month's bucket takes the new figure.

## Reachability

The same three declarations as `set_org_billing_terms`: `platformOnly: true` (the kernel refuses the call without a binding minted by `createPlatformOperatorContext`, INV-31), `surfaces: []`, and `defaultEffect: "deny"` with `defaultRoles: {}`. `layers` lists `schema`, `unit` and `docs`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `orgId` | string | yes | uuid |
| `agreementRef` | string | yes | 1 to 140 characters; printed on invoice lines |
| `currency` | string | yes | ISO 4217, lower case |
| `ratePerGauMicros` | string | yes | whole micro-units of the currency per GAU, as digits |
| `blockSizeGau` | integer | yes | 1 or more |
| `includedGauPerMonth` | integer | yes | 0 or more |
| `effectiveFrom` | string | no | RFC 3339; defaults to the moment of the call |

`ratePerGauMicros × blockSizeGau` must be a multiple of 10,000, so a block costs a whole number of cents. The handler checks this before any write and names the figures in the refusal. The table's CHECK is the backstop.

## Output

The open agreement after the call: `orgId`, `agreementRef`, `currency`, `ratePerGauMicros`, `blockSizeGau`, `includedGauPerMonth`, `effectiveFrom`, plus `changed` (false when the open agreement already carried these terms) and `previous` (the agreement this call closed, with its `effectiveTo`, or null).

## Side effects

In one `withSystemDb` transaction under an advisory lock on the org: the open row's `effective_to` is set to the new `effectiveFrom`, and the new row is inserted. The partial unique index on the open row backs the lock. A call whose terms match the open row writes nothing.

When something changed, the handler awaits `emitSecurityEventAsync` for a `billing.plan_changed` row naming the target org and the operator run's request id. The script registers the kernel's emitter, so the `capability.invoke_*` row is written too.

## The one caller

```
pnpm billing:contract-terms --org <slug> --agreement <ref> --rate-per-1000-usd <n> \
  --block-size <n> --included-per-month <n> [--currency usd] [--from <iso>] [--dry-run]
```

`tools/scripts/billing-contract-terms.ts`. The runbook is `docs/ops/enterprise-invoicing.md`.

## Errors

| code | meaning |
|---|---|
| `authz_denied` (`CapabilityError`) | the context carries no platform-operator binding, or one the kernel did not mint |
| `invalid_input` | a field is missing or malformed, or the terms were refused: `block_not_whole_cents`, `starts_before_current` (the open agreement starts at or after `effectiveFrom`), or another reason the message names |
