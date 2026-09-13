# ADR-052: The governed action is the billable unit; tokens are reported, never billed

- **Status:** Accepted
- **Date:** 2026-09-08
- **Owners:** platform
- **Related:** ADR-042 (organisation data planes), ADR-043 (Oxagen governs, does
  not run), [docs/VISION.md](../VISION.md) (metering → billing pillar),
  [docs/specs/governed-action-metering.md](../specs/governed-action-metering.md)
  (the implementation spec),
  `packages/oxagen/src/kernel.ts` (`setBillingAdmissionGate`),
  `packages/billing/src/metering.ts` (`meterCreditsForUsage`,
  `chargeUsageCredits`),
  `packages/billing/src/reseller-pricing.ts` (`per_unit` mode),
  `packages/billing/src/rate-card.ts` (the model rate card)

## Context

Oxagen has always described itself as metered, but never decided *what it
meters*. The code answered the question by accident.

Today a charge is raised at the model call. `@oxagen/ai` calls
`chargeUsageCredits`, which reaches `meterCreditsForUsage` —
`creditsForCostUsd(providerCostUsd(usage, rateCard), markup)`. Credits are the
provider's token cost, marked up. The kernel's billing gate is admission only:
`BillingAdmissionGateFn = (orgId: string) => Promise<void>` decides whether an
org may proceed and records no unit at all.

Two facts make that indefensible rather than merely unfashionable.

**BYOK.** Vendor-neutral bring-your-own-key is a design constraint, not an
add-on. The customer's keys, the customer's account, the customer's invoice from
Anthropic. Oxagen never intermediates a token and never bears its cost. A markup
over `providerCostUsd` therefore charges margin on a bill Oxagen did not pay —
which is a tax, and reads as one the first time a customer reconciles the two
statements side by side.

**ADR-043.** Oxagen governs agents; it does not run them. There is no sandbox,
no engine, no worker. Nothing in this repo costs more because a run was long.
The marginal cost of a governed action is a gate read, a graph query and an
append — near-flat, and small. The one cost that genuinely grows is evidence
retention, and it grows with *time held*, not with tokens spent.

So the current meter tracks the customer's cost curve instead of Oxagen's, on a
cost Oxagen does not carry, for a product that does not scale with the thing
being counted. It also cannot be explained: a reseller re-billing a customer
under `reseller-pricing.ts` cannot put a token count on an invoice and expect it
to survive a procurement review.

## Decision

### The billable unit is the governed action

**A governed action is one top-level `invoke()` that resolves to a registered
capability, is admitted by the IAM and entitlement gates, executes its handler,
and writes an audit record.**

One gate decision plus one durable record — which is precisely the product. The
kernel is already the single chokepoint every surface passes through, so the
thing being sold and the thing being counted are the same event.

Four exclusions are part of the definition, not policy layered over it:

1. **Only the outermost invoke in a call tree bills.** A handler that internally
   invokes other capabilities does not multiply the charge. Oxagen's internal
   call graph is an implementation detail that changes between releases and that
   the customer cannot see; billing on it would make the invoice unpredictable
   in exactly the way this ADR exists to prevent.
2. **`noBillingGate: true` capabilities are free.** Reading your own spend,
   budget, settings or membership is never a charge. Charging someone to look at
   their bill is indefensible and the flag already marks the set.
3. **Denials are free.** A gate that says no did its job. Billing a denial would
   pay Oxagen more when a customer's policy is more restrictive — an incentive
   pointed directly against the customer's interest.
4. **A retry within one attempt bills once.** A flaky downstream is not a
   billable event; the logical action is.

### Tokens are reported in full and billed at zero

`rate-card.ts` already prices every model family, including cache-read and
cache-write rates, and `rate-card-parity.test.ts` keeps it honest against
`pricing.ts`. That capability becomes a customer-facing FinOps feature carrying
no charge.

This is a commercial position, not an omission. Oxagen's roadmap says an owned
model will reduce a customer's token bill; a vendor earning a percentage of that
bill cannot make that argument. Giving up the line buys the right to make it.

### Retention beyond twelve months is the second meter

Evidence is the asset and holding it is the cost that compounds. Twelve months
are included; beyond that, storage is priced per GB-month. One meter for the
decision, one for the durable record, and nothing else.

### Price is set by tier allowance plus per-action overage

Volume tiers on a published rate card, with each subscription tier carrying an
included allowance. Rates, allowances and worked examples live in the spec,
because they will move and an ADR does not get edited after acceptance.

## Alternatives

**Cost-derived credits (the status quo).** Rejected: it marks up a cost Oxagen
does not bear, it is unpredictable before purchase, and no reseller can re-bill
it. It survives as reporting.

**Flat per governed run.** Rejected as a *meter*, kept as a *quote*. A run
varies roughly a hundredfold in size; a flat price means whoever runs many small
jobs subsidises whoever runs few large ones, and every renewal reopens the
argument. Runs remain the unit customers estimate in — the spec carries the
conversion — but actions are what accrue.

**Run size classes (S/M/L/XL brackets).** Rejected, and the strongest of the
rejected options: it reads like shipping weight and needs no conversion. It
loses on bracket edges, which generate disputes forever and reward gaming a
threshold. Held in reserve if buyer legibility ever outranks precision.

**Per governed agent identity.** Rejected on product grounds, not commercial
ones. It charges a customer for creating narrowly scoped agent identities, which
is the exact hygiene agent IAM exists to encourage; the rational response is to
consolidate into one over-permissioned agent. A price that argues against the
product is worse than a low one.

**A percentage of governed model spend.** Rejected: it scales perfectly and
aligns Oxagen's revenue against the customer's interest. It also contradicts the
owned-model roadmap outright.

## Consequences

**The meter moves from the model call to the kernel.** `@oxagen/ai` stops being
a charging path and becomes a reporting one. The kernel's admission gate gains a
recording sibling; admission and accrual stay separate functions, because a gate
that also bills is a gate that fails open when billing is down.

**The reseller layer needs nothing.** `reseller-pricing.ts` already implements
`per_unit` — "flat cents per metered unit, cost-independent" — beside `markup`.
This ADR makes the mode that already exists the primary one.

**Some bills move, and not all of them down.** A customer whose agents make many
cheap gate calls against a small model pays more under a count than under a
cost. That is the correct answer — they consume more governance — but it is a
real migration event and the spec owns the transition.

**`CONSUME_TOKEN_OVERAGE` loses its meaning.** The credit-ledger reason vocabulary
in `constants.ts` was written for a cost-derived world. `CONSUME_EXECUTION` and
`CONSUME_TOOL_CALL` survive; the token reason is retired rather than repurposed,
so a historical ledger row keeps meaning what it meant.

### What retirement means, exactly — writes reject, reads accept

Retiring a ledger reason is ambiguous until someone says which direction it
binds, and the ambiguity is not academic: the write allowlist in `credits.ts`
and the read filters in the usage and dispute paths both derive from the same
constant, so a single answer has to serve both. Three readings were available.

1. **Retire for writes only.** The string stays legal on a row and illegal in a
   new one.
2. **Keep accepting it during a deprecation window**, with the allowlist warning
   rather than rejecting.
3. **Retire it fully** and migrate every historical row to another reason.

**Decision: (1).** `consume_token_overage` is rejected by `consumeCredits`,
`grantCredits` and `adjustCredits` — anything that writes — and remains valid
everywhere a row is read, filtered or refunded.

(2) is rejected because a warning is not a boundary. The interval it opens is an
interval in which a newly-written row carries a reason this ADR says no longer
describes anything, and the person who writes that row is exactly the person who
did not read the warning. There is no live writer today, so the window would
protect nobody and permit only the mistake.

(3) is rejected because it is the one option that breaks the invariant the
retirement exists to protect. Rewriting 2024–2026's rows to `consume_execution`
would make a cost-derived debit claim to be an action-derived one, and a ledger
whose past rows change meaning is not a ledger. The rows stay as they are.

In code this is `CREDIT_REASONS` (the write vocabulary) and
`HISTORICAL_CREDIT_REASONS` (write plus `RETIRED_CREDIT_REASONS`, the read
vocabulary), in `packages/billing/src/constants.ts`. The `credit_ledger.reason`
column is plain `text` with no CHECK constraint in the Atlas schema, so the
enforcement is the allowlist and nothing else — which is why the allowlist
rejecting rather than warning is load-bearing.

**Buyers need a conversion.** "Governed action" is precise and "run" is legible,
and they are not the same word. A published calculator — typical runs by class,
with their action counts — is part of shipping this, not a nicety.
