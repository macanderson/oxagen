# ADR-048: One path glob, in a package with no dependencies

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #1387 (a deny rule for a dotfile did not match it at the
  workspace root), ADR-041 (canonical JSON — one rule, not one implementation),
  `packages/glob/src/glob.ts`, `packages/mcp-config/src/permissions.ts`

## Context

`globToRegExp` was defined in four packages. Three were byte-identical;
`@oxagen/ingestion`'s was the same rules written a different way. A fifth copy,
in the CLI's permission broker, was missing one line — the one that consumes the
separator after `**` — so `**` plus `/.env` required a directory and did not
match `.env` at the workspace root. That copy was the one deciding
`allow | deny`, and a rule that does not match is a rule that does not deny.

Nothing compared the copies. The divergence was found by reading them side by
side, months after it shipped.

ADR-041 faced the same question about canonical JSON and answered it the other
way: share the rule, keep the implementations. That was right there because
those modules sit at different trust boundaries — one faces a hostile peer and
pays for it, and merging them would have moved that cost to the wrong side.

Nothing like that is true here. All four copies filter paths for the same kind
of caller. They had nothing to disagree about, and disagreed anyway.

## Decision

**One implementation, in `@oxagen/glob`, a package with no dependencies.**

`@oxagen/ingestion` and `@oxagen/github` share no dependency, so no existing
package could hold this. The nearest candidate, `@oxagen/agent-engine`, pulls
the AI SDK — a cost `ingestion` should not pay for a nine-line function, and a
dependency edge from a data pipeline to the agent loop that would be wrong even
if it were free. So this is case (b) of the new-package rule: a direction the
current graph forbids.

The semantics live in `packages/glob/src/glob.test.ts` as a table, which is the
half that keeps this from happening again. A rule that is not in the table is a
rule nothing holds.

**`**` followed by a separator means zero or more whole segments.** Every
surviving copy emitted a bare `.*` after consuming the slash, so `**` plus
`/.env` also matched `foo.env` — a rule about one file silently becoming a rule
about every name ending in it. Consuming the separator and emitting `(?:.*/)?`
is the only shape that is neither over-broad nor requires a directory nobody
asked for.

**`matchGlob` in `@oxagen/mcp-config` stays separate**, and this is ADR-041's
reasoning applied honestly rather than an exception to this one. It matches flat
values — MCP tool names and URLs — where `*` is expected to cross every
separator. Merging them would make a tool-name rule and a path rule mean the
same thing by the same character, which they do not.

## Consequences

- Four packages take a new dependency. It has none of its own, so the cost is
  one lockfile entry each.
- A change to path-glob semantics is now one diff with one test table, rather
  than four diffs that can be applied to three of four places.
- The stricter `**` rule narrows existing patterns. A filter written as `**`
  plus `/.env` stops matching `foo.env`. That is the correct reading and the one
  every glob a user has met gives, but it is a behaviour change, not only a
  cleanup.
- Anyone adding a fifth copy has somewhere obvious to import from and a table
  that will disagree with them if they do not.
