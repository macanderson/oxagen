# ADR-069 — One writer for the account preference row

- Status: accepted
- Date: 2026-09-16
- Supersedes nothing. Amends the `update_user_preferences` removal made on
  `app-rebuild-g2968-be` (PR #3055).

## Context

`auth.user_preferences` is one row per person, holding nine writable values:
`language`, `theme`, `timezone`, `font_size`, `density`, `enter_to_submit`,
`pending_prompt_behavior`, `default_text_tier`, `default_text_model`.

Two capabilities read and wrote it:

- `get_user_preferences` — returns all nine.
- `update_user_preferences` — wrote all nine. Deleted in #3055 in favour of the
  Appendix E name `set_preferences`.
- `set_preferences` — added in #3055, carrying three: `locale`, `theme`,
  `timezone`.

The removal left three defects, all of them live:

1. `apps/app_deprecated/src/app/account/preferences/preferences-action.ts` still
   called `invoke("update_user_preferences", …)` by string. `invoke` takes a
   `string`, so the compiler saw nothing, and the action's own test mocks
   `invoke`, so the suite saw nothing either. That app serves production until
   cutover — the same app whose onboarding path `packages/billing/src/grants.ts`
   documents as production-serving. Every save on the Account Preferences page
   would have thrown `No capability registered`.
2. Six of the nine fields became unwritable on every surface. Two of them are
   read back on the hot path: `prepareAssistantTurn` calls
   `loadEffectiveModelDefaults`, which reads `default_text_tier` and
   `default_text_model`. With no writer they are NULL for every user forever, so
   the per-user model default is a setting the product reads and nobody can set.
3. `packages/oxagen/src/contracts/v2/set-preferences.ts` still listed
   `update_user_preferences` in `absorbs`. `exhaustive.test.ts` resolves an
   absorbed name to a file and, when the file no longer registers that name but
   does register the tool's own, treats it as an in-place carry and **skips the
   field comparison**. That escape hatch is why the nine-to-three shrink passed
   the one test built to catch exactly this.

## Decision

**One capability writes the account preference row, and it carries every field
the read returns.**

- `set_preferences` is that capability. It keeps its Appendix E name and gains
  the six missing fields on both input and output. Its input stays a partial
  write; the two nullable model fields keep the three-way distinction the column
  encodes (omitted = no change, `null` = clear, value = set).
- `update_user_preferences` stays deleted. It is not re-registered as a
  compatibility shim.
- `apps/app_deprecated`'s preferences action is ported to `set_preferences` in
  the same change, mapping its `language` field to the contract's `locale`. It
  no longer passes `{ surface: "agent" }` — the contract's allowlist is
  `["api", "mcp"]`, this call is neither, and the previous code's own comment
  admitted the value was chosen to satisfy the allowlist rather than to describe
  the call.
- The v2 descriptor's `absorbs` names `set_preferences`, the contract that
  exists. That switches `exhaustive.test.ts` from the skip branch to a real
  field-by-field comparison, and the `locale` → `language` rename is declared
  rather than inferred.

## Alternatives

**Re-register `update_user_preferences` until `app_deprecated` retires.** Cheap,
and wrong under SCR-002. It leaves two write contracts for one row with
overlapping fields, two IAM grants, two metering rows, two docs pages and two
things to keep in step — and the retirement date is a date nobody has set. The
shim would outlive the reason for it, which is what a durable choice has to
avoid.

**Leave the six fields unwritable and delete them from the read.** This treats a
shipped preference as an accident. `pending_prompt_behavior` and the two model
defaults are read by live code; `font_size` and `density` are mirrored into
cookies for flash-free SSR. Deleting the read is a product change dressed as a
cleanup.

**Add an `"app"` surface so the deprecated action can name its surface.** A
separate decision about the surface vocabulary, not about this row. Omitting the
override is correct today: the kernel only enforces the allowlist when a surface
is named, and `ctx.surface` already records `"app"` on the event.

## Consequences

- One contract, one handler, one docs page for the preference row.
- The per-user default model tier becomes settable, which is what
  `loadEffectiveModelDefaults` has always assumed.
- `apps/app_deprecated` gains a test that parses the exact payload it builds
  against the live contract schema, so the next rename fails in that file rather
  than in production. A mocked `invoke` cannot catch a contract that moved; a
  parse against the real schema can.
- The v2 carry proof covers this tool for the first time. The in-place-carry
  escape hatch in `exhaustive.test.ts` remains for tools that genuinely need it,
  but it is no longer load-bearing here.

## Enforcement

- `packages/oxagen/src/contracts/user.preferences.set.test.ts` holds the input
  and output shapes against the read contract's output.
- `apps/app_deprecated/src/app/account/preferences/preferences-action.test.ts`
  parses the action's payload with `userPreferencesSet.input`.
- `packages/oxagen/src/contracts/v2/exhaustive.test.ts` compares the v1 input
  field-for-field against the v2 tool.
