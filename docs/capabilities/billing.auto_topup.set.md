# set_auto_topup

**Capability:** `set_auto_topup`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler writes the org the caller's tenant scope names)
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; changing a billing setting is never a governed action, ADR-052 exclusion 2, INV-27)

## Intent

The Auto top-up control on the Billing page (`apps/app/ARCHITECTURE.md` §1.4, §3.9 item 12). It decides whether the recorder charges the organization's saved card when its governed-action-unit bucket runs out, and how many 5,000-GAU blocks each top-up buys.

The two columns (`billing.org_billing_settings.auto_topup_enabled`, `auto_topup_blocks`) default to on and one block for every organization on every tier, so the common case needs no call here: a Free organization that saves a card auto tops up one block at the list rate. This capability is how an organization changes that.

The write is accepted in either billing mode and whether or not a card is on file. The columns exist on every organization; the recorder reads them only in prepaid mode, and only once a card exists. An invoice-billed organization may set them, and they stay inert until the mode changes.

`noBillingGate: true` is load-bearing: `remaining = 0` is exactly when a customer comes here to turn auto top-up on, so the gate must not be what stops them.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `enabled` | boolean | yes | — |
| `blocks` | integer | yes | 1-100; the column's CHECK is `> 0` |

## Output

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | as stored |
| `blocks` | integer | as stored |

The handler returns what the upsert wrote back, not what the caller sent.

## Roles

Org Owner or Admin, for the signed-in user or, on an API-key call, the key's creator (`resolveActingUserId`). The handler checks the role with `assertOrgRole`; the kernel's IAM check allows every capability for a non-enterprise org (INV-29), so a Member, a Billing user or a Viewer is refused by the handler with `forbidden`.

## Side effects

One upsert on `billing.org_billing_settings`, keyed on `org_id` — an organization with no settings row gets one, and one that has a row keeps every other column. Audited: `emitSecurityEvent` writes a `billing.auto_reload_updated` row naming the acting user, the org and this capability.

## Surfaces

- `PUT /v1/{org}/{ws}/billing/auto-topup`
- MCP tool `set_auto_topup`

No `app` layer: WL-50 binds the control on the Billing page.

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | no signed-in user and no API key with a live creator, or the acting user (the signed-in user, or the key's creator) holds neither Owner nor Admin in the org |
| `invalid_input` | `blocks` outside 1-100, a non-integer, a missing field, or an unknown key |
