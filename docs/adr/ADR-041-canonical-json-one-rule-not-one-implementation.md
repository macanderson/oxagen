# ADR-041: Canonical JSON — one rule, not one implementation

- **Status:** Accepted
- **Date:** 2026-09-06
- **Owners:** platform
- **Related:** issue #1415 (engram's serializer collapses Date/Map/Set to `{}`),
  issue #1402 (the same defect in the deleted `@oxagen/replay`), ADR-040
  (governance-plane refocus, which is why `replay` is gone),
  `packages/run-evidence/src/digest.ts` (RFC 8785 + captured intrinsics),
  `packages/agent-runner/src/run-spec-v2.ts` (`canonicalJson`, the strict
  in-process canonicalizer)

## Context

Four modules in this repository serialize a value to canonical JSON so it can
be hashed, and they had four behaviours:

| module | approach | Date / Map / Set |
| --- | --- | --- |
| `packages/run-evidence/src/digest.ts` | RFC 8785 (JCS) over a hardened snapshot | rejected |
| `packages/agent-runner/src/run-spec-v2.ts` | hand-rolled, path-carrying errors | rejected |
| `packages/engram/src/canonical-json.ts` | hand-rolled walker | **collapsed to `{}`** |
| `packages/handlers/src/registry-digest.ts` | `sortKeysDeep` + `JSON.stringify` | **collapsed to `{}`** |

`typeof x === "object"` is true for a `Date`, a `Map` and a `Set`, and
`Object.keys` returns `[]` for all three, so the bottom two rendered every one
of them as `{}`. In a content-addressed store the hash *is* the identity, so
two records differing only in a timestamp were one record: the second write
deduped onto the first and replay returned the first payload, with an intact
integrity check, because the content really did hash to the ref it was filed
under.

Issue #1415 asks the question this ADR answers: should engram adopt
run-evidence's implementation rather than repair its own, given that repairing
them separately is how four implementations became four behaviours?

## Decision

**Share the rule; do not share the implementation.**

The rule, which every canonicalizer in this repository now follows:

1. A value is represented faithfully or refused. There is no branch that emits
   something lossy.
2. `toJSON()` is honoured where a value has one, so a `Date` hashes as its ISO
   string — matching `JSON.stringify`, the baseline these modules exist to
   improve on.
3. Object keys sort by UTF-16 code unit (RFC 8785's rule, and what
   `Array#sort` does by default). Array order is preserved.
4. Anything else that is not a plain object — `Map`, `Set`, `RegExp`, a class
   instance with no `toJSON` — throws an error naming the constructor and the
   path to the offending value.
5. A cycle throws rather than overflowing the stack.

The implementations stay separate because they sit at different trust
boundaries, and merging them would move cost to the wrong side of each:

- **`run-evidence` faces a hostile peer.** It captures intrinsics at module
  load, rejects proxies, validates unpaired surrogates, and refuses anything
  that is not already a JSON wire value, because a caller may be trying to make
  two different documents digest the same. It also carries the CGP SDK and
  `canonicalize` as dependencies.
- **`engram` and `agent-runner` hash trusted in-process values.** They need the
  rule, not the isolation machinery, and engram taking `@oxagen/run-evidence`
  would pull the CGP SDK into the memory plane to get it.

So the choice is not "one implementation or four". It is one *rule* with two
enforcement strengths, and the strength is chosen by who can reach the input.

`@oxagen/replay`'s copy needed no decision: the package was deleted with the
in-process agent runtime under ADR-040, which closes #1402.

## Consequences

- Engram's `canonicalStringify` throws `CanonicalJsonError` where it used to
  return `{}`. Every value that serialized correctly before serializes to the
  identical bytes, so no record already in a store is re-identified — only the
  values that were already colliding change, and they change from one shared id
  to an error or to distinct ids.
- A caller that was passing a `Date` into a hashed body now finds out at the
  write instead of at the collision. That is the point: the failure was
  previously invisible, and a store that silently contains fewer records than
  were written is the hardest kind of corruption to notice.
- A fifth canonicalizer is a review question, not a free choice. It has to state
  which trust boundary it sits at and follow the five rules above.
- The rule is asserted from the inequality direction — distinct inputs produce
  distinct outputs — because every one of these modules had tests covering only
  the equality half, and the equality half is the half that was never broken.
