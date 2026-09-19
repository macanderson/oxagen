# ADR-111: An amount measure's unit is refused at declaration, not widened at `Money`

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** kernel, app
- **Related:** ADR-108 (a mandate limit carries its own measure kind); ADR-059
  (mandates, the ledger, the consequence roles that gate a grant); Mission
  Control spec §6.9 part 3; issue #3448 (residue from #3442); `docs/capabilities/`
  entries for `publish_tool_declaration`, `import_tool`, `grant_mandate`,
  `update_mandate_limits`
- **Delivered by:** `isIso4217Currency` and `measureDeclarationSchema`'s
  `superRefine` (`packages/oxagen/src/mandates/schemas.ts`)

## Context

A tool version declares a measure's `unit` (`measureDeclarationSchema`,
`packages/oxagen/src/mandates/schemas.ts`): a currency code for an `amount`
measure, an arbitrary unit name for a `count`. Before this change the schema
bounded `unit` only by length (1–32 characters) — any string passed, for
either type.

`apps/app/src/data/contracts/money.ts` declares `Money.currency` as exactly
three characters, matching ISO 4217. `measureValue`
(`apps/app/src/data/live/mappers/mandates.ts`) builds a `Money` value
straight from a limit's `currencyOrUnit` whenever the limit's stored `kind`
(ADR-108) is `"money"`. A declaration such as `{ type: "amount", unit:
"USDC" }` therefore passed `measureDeclarationSchema` at publish time,
passed the unit-match check `assertToolsDeclareMeasures` runs at grant time
(`packages/handlers/src/_mandate.ts`), and only failed the first time
`list_mandates` or `get_mandate` mapped it for the app: `Money.safeParse`
refused the four-character currency, and `MandateList.safeParse` /
`MandateDetail.safeParse` answered `record_unmappable` for **every** mandate
naming that measure, not only the one with the non-ISO unit. Two contradictory
constraints existed on the same fact — the declaration schema's 32-character
bound and `Money`'s 3-character bound — and nothing enforced them against each
other until the read path, three writes and one page load later.

## Decision

**An `amount`-typed measure's `unit` must be an ISO 4217 currency code, enforced
in `measureDeclarationSchema` itself.** `type === "count"` remains
unconstrained, because a count may legitimately carry a currency-code unit
(`{ type: "count", unit: "USD" }` — a count of dollar bills, not an amount of
dollars; ADR-108's own example). `Money.currency`'s three-character bound is
unchanged.

This is the durability-first call (SCR-002) between the two the issue named:

1. **Reject at the write boundary (chosen).** `measureDeclarationSchema` is
   the one schema every tool declaration passes through
   (`publish_tool_declaration`, `import_tool`), the same choke point ADR-108
   already established for the money-or-count fact itself. A non-ISO unit on
   an `amount` measure is refused there, before it is ever stored, with a
   typed Zod issue naming the field. `grant_mandate` and `update_mandate_limits`
   need no separate check: `assertToolsDeclareMeasures` already refuses a
   mandate limit whose `currencyOrUnit` does not equal the matched tool's
   declared `unit` (`measure_unit_mismatch`), so once the declared unit is
   guaranteed ISO 4217, every limit denominated against it is too, by the
   equality check that already existed.
2. **Widen `Money.currency` to accept whatever the declaration schema accepts
   (rejected).** `Money` is read by every screen that prints a figure, by
   Stripe integration code that expects ISO 4217 minor-unit currency codes,
   and by `sumMoney`/`ratioOfMicros` in the same file, which compare
   `currency` strings for equality with no normalization. Widening the field
   admits USDC and any other 3-to-32-character string a tool author chooses,
   permanently weakening a type this codebase treats as "an ISO 4217 code" in
   comments, formatting, and billing integration alike — a decision that
   compounds with every future `Money` consumer, for one non-standard token
   unit that the write boundary can refuse for free.

Option 1 keeps `Money` a genuinely ISO 4217 type, matches how the codebase
already treats a currency code everywhere else, and closes the defect at its
actual source: a declaration schema that allowed a unit its own type
disagreed with, thirty-two characters wide, for a fact meant to be three.

## Consequences

- A tool author declaring an `amount` measure denominated in a
  non-ISO-4217 token (USDC, a loyalty-points balance, etc.) must declare it
  as `type: "count"` instead — an accurate description, since `Money` and
  the currency-formatted UI are for ISO 4217 money, not an arbitrary token
  balance. `publish_tool_declaration` and `import_tool` refuse the
  declaration with a clear Zod issue (`unit`) rather than accepting it and
  failing three steps later on a different page.
- Existing declarations written before this ADR are not backfilled or
  re-validated; a tool that already has a stored `{ type: "amount", unit:
  "USDC" }` declaration keeps it (jsonb has no schema enforcement at rest).
  Its next re-publish through `publish_tool_declaration` refuses the update
  until the unit is fixed, and in the meantime `assertToolsDeclareMeasures`'s
  `measureDeclarationsSchema.safeParse` treats the whole `tool.measures`
  blob as unparseable, so a mandate naming that measure is refused
  `measure_not_declared` at the next grant or limit change rather than
  granted against a unit that will fail to map for the app — a stricter, but
  safe, failure mode for a row this old.
- No `Money` consumer changes: the three-character `currency` field, the
  ISO 4217 comments throughout `packages/billing`, and every screen that
  formats a `Money` value stay exactly as they were.
