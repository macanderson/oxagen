# ADR-037: A test double must fail when the thing it doubles moves

- **Status:** Accepted
- **Date:** 2026-08-24
- **Owners:** platform / testing
- **Related:** #1172 (the four failures this answers), #1148, #1156, #1163,
  #1169, #1171

## Context

Four failures on `main` in a row shared one cause, and each was invisible until
the package ahead of it in `turbo`'s order went green, so they surfaced one at a
time over several hours rather than together.

| Issue | What moved in source | What was left behind |
|---|---|---|
| #1148 | `CachedUsage` gained `cacheWriteTokens` | `cache.test.ts` fixture literals |
| #1156 / #1163 | `SECURITY_EVENT_TYPES` gained `billing.budget_updated` | the `security_events` CHECK constraint |
| #1169 | the AI SDK renamed `cacheCreationTokens` → `cacheWriteTokens` | the witness test's mocked usage payload |
| #1171 | the kernel renamed the admission-gate export | `bootstrap.test.ts`'s `vi.mock` factory |

Every one is a source change whose double was not carried with it. A
hand-written double is a structural copy the compiler never checks against its
original: `vi.mock("mod", () => ({ a, b }))` replaces the module wholesale, so
renaming an export leaves the mock returning the old name, the importer gets
`undefined`, and the test that dies is a different one from the test that lied.

## What the compiler actually catches

#1172 proposed four remedies. Before adopting any, each was tried against
`packages/billing/src/bootstrap.test.ts` — the #1171 file — by renaming an
override and running `pnpm --filter @oxagen/billing typecheck`. The results
decided this ADR, and two of them were not what the issue assumed:

| Form | Rename caught at typecheck? |
|---|---|
| `vi.mock(m, () => ({ ... }))` | no |
| `vi.mock(m, async (io) => ({ ...(await io<typeof import(m)>()), ... }))` | **no** |
| `... satisfies typeof import(m)` | yes — `TS2561` |
| `... satisfies Pick<typeof import(m), "name">` | yes — `TS2344` |

`importOriginal` alone does **not** catch a rename. Vitest infers the factory's
return type rather than checking it against the module, so an override naming a
nonexistent export is just another property. `importOriginal` solves a different
problem — keeping the exports a test does not override real — and is worth using
for that, but it is not the guard.

The guard is `satisfies`. The choice between its two forms is about cost:

- `satisfies typeof import(m)` demands the factory reproduce **every** export.
  For `./metering` that is twelve, and for `./logger` it is a full pino
  `Logger` — `level`, `fatal`, `trace`, `silent`, `msgPrefix` — to stand in for
  four methods a bootstrap test reads. Measured, not guessed: it produced
  `TS2322` on the logger double.
- `satisfies Pick<typeof import(m), "a" | "b">` asks only the question that
  matters — do the names this file replaces still exist? — and a rename fails on
  the `Pick` constraint itself.

Spreading `importOriginal` to get completeness cheaply looks attractive and is
a trap here: it imports the real module. In `bootstrap.test.ts` that means the
real kernel, database client and pino logger, and the suite went from 47ms to
timing out against a 5s limit.

## Decision

**1. A `vi.mock` factory for a workspace module carries
`satisfies Pick<typeof import("..."), <the names it replaces>>`.** This is the
default and it is nearly free: `Pick` is a type, so it costs nothing at runtime,
and it turns #1171 into a typecheck error in the file that caused it.

**2. Use `satisfies typeof import("...")` when the double is genuinely the whole
module** and the export surface is small enough to state. It is strictly
stronger; it is only sometimes affordable.

**3. Skip the annotation, with a comment saying why, when the type is
disproportionate** — the `logger` case. A comment is honest; a cast that looks
like a check and is none is not.

**4. Use `importOriginal` when a test needs the unmocked exports to be real**,
not as a rename guard, and never for a module with import-time side effects.

**5. Fixture builders, not literals, for any shape with more than two fields.**
One typed builder per shape, so a new required field breaks one function rather
than every literal. `packages/ai/src/cache.test.ts`'s `makeUsage` is the
reference and already the pattern — #1148's fix.

**6. Assert a derived constraint against its source in a test.** Where a
TypeScript list is mirrored into a database CHECK constraint, a test asserts
equality. `packages/compliance/src/security-event-types.test.ts` — "the latest
event_type migration contains every value in `SECURITY_EVENT_TYPES`" — is the
reference, and is what #1163 was missing rather than what it got wrong.

## Scope, stated honestly

This governs **new and modified** mocks. It is not a mass conversion, and saying
so is the point: there are **2,240 `vi.mock` factories naming a workspace module
(`@oxagen/*` or a relative path) across 834 test files**. A rule that claims to
cover all of them on the day it is written is one nobody can comply with.

Those counts are the argument for a **down-only ratchet** — a check that records
today's number and refuses to let it rise. That gate is not built here; it is
filed as follow-up, and it will need its baseline generated at that moment
rather than from these numbers, which will have drifted.

Until it exists this is enforced in review, and a reviewer has one question to
ask: *if the thing this doubles were renamed tomorrow, what would fail, and
would it be this test?*

## Consequences

- Remedies 5 and 6 were already implemented by the #1148 and #1163 fixes; this
  ADR records them as decided rather than incidental.
- `packages/billing/src/bootstrap.test.ts` is converted as the worked example,
  and it got faster: 4.9s to 47ms, because the annotation replaced an import.
- Point 3 means some doubles stay unguarded on purpose. Each one owes a comment
  naming the type that made the check disproportionate.
