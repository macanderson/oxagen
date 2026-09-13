---
name: timestamptz-arrives-as-date-or-iso-string
type: observation
domain: database
severity: P1
github: 2714
date: 2026-09-11
---

**Observation:** a Postgres `timestamptz` reaches TypeScript as **two different
types depending on the path**, and several row types in this repo declare only
one of them.

- The driver (postgres.js, and Drizzle's raw `execute`) decodes it to a JS
  `Date`.
- An Inngest **step boundary** JSON-serialises that `Date` back to an ISO
  string, so the same field is a string on the far side of `step.run`.

**How it bites:** the declared type is usually `string | null`, written by
someone picturing the JSON shape, and the cast that produces it is
`as unknown as Row[]` — an assertion, so TypeScript never checks it. Whether
that is harmless or silent depends entirely on what the consumer does:

| consumer | with a Date | verdict |
|---|---|---|
| `new Date(x)` | works, clones | harmless |
| `typeof x === "string"` | **drops the value silently** | the #2714 bug |
| `x.slice()` / `x.startsWith()` | throws | loud, at least visible |
| `[a, b].sort()` | wrong order (`Date#toString` is not sortable) | silent and wrong |

**Where it was live:** `tools/scripts/count-unenforced-iam-orgs.ts` filtered its
date candidates with `typeof x === "string"`, so every date failed and the
exposure report printed "nothing in the row dates it" for every organisation —
discarding the only answer it had. Its unit tests passed throughout, because a
fixture hands in a string. **Fixtures encode the author's mental model, so they
cannot falsify it.**

**Fix shape:** normalise at the query boundary (`toIsoOrNull`) so the declared
type becomes true, rather than widening the filter downstream. Widening hides
the lie; normalising removes it.

**Audited 2026-09-11:** `provision-webhook.ts` and `resolve-connection-auth.ts`
both declared `string` and received `Date` (fixed, neither was live).
`auth.session-expiry-audit.ts` already handled both shapes inline and is where
the Inngest-serialisation half of this was first written down.

**Watch-outs:** any `as unknown as <Row>[]` over a raw query is unchecked — grep
for it before trusting a row type. When testing one, hand the test a `Date`,
not a string. See [[jsdoc-never-throws-was-not-implemented]] for the sibling
instinct: test the claim, not the code you expect.
