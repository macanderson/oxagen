# @oxagen/glob

The path glob for every package that can take a workspace dependency.
`@oxagen/tacho` cannot, and keeps its own copy (see "Other globs in the tree").

```ts
import { globToRegExp, matchesGlob } from "@oxagen/glob";

matchesGlob("**/.env", ".env"); // true
matchesGlob("**/.env", "config/.env"); // true
matchesGlob("**/.env", "foo.env"); // false
matchesGlob("src/*.ts", "src/a/b.ts"); // false — `*` stays in one segment
```

## Boundary

- **Owns:** `globToRegExp` and `matchesGlob` for path patterns, and the table
  of semantics in `src/glob.test.ts`.
- **Does not own:**
  - Flat-value matching for MCP tool names and URLs, where `*` crosses every
    separator: [`@oxagen/mcp-config`](../mcp-config/README.md) (`matchGlob`).
  - Path rules in Tacho's policy bundle: [`@oxagen/tacho`](../tacho/README.md)
    (`globToRegex` in `packages/tacho/src/host/bundle.ts`).
- **Depends on:** No `@oxagen/*` runtime dependencies. It has no runtime
  dependencies at all.
- **Used by:** `@oxagen/ingestion`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `globToRegExp` / `matchesGlob` | export | `packages/glob/src/glob.ts` | `packages/ingestion/src/filters.ts` |

## Entry points

- `.` (`src/index.ts`): `globToRegExp` and `matchesGlob`.

## Tests

```bash
pnpm --filter @oxagen/glob test:unit src/glob.test.ts
```

`src/glob.test.ts` is the only test file.

## What it supports

`**` (any run of characters), `**` plus a separator (zero or more whole
segments), `*` (within one segment), `?` (one character, never a separator), and
literal text with regex metacharacters escaped. Patterns are anchored at both
ends.

No brace expansion, no character classes, no negation, no extglob. A pattern
using them matches literally — which fails closed for an allow rule and open for
a deny rule, so a deny rule wants a plain pattern.

## Why this package exists

Four packages carried their own copy of this function. Three were byte-identical
and the fourth was the same rules written differently. Nothing compared them, so
when a fifth copy lost the line that consumes the separator after `**`, the
divergence was found by reading — months later, and only because that copy was
the one deciding `allow | deny` in the permission gate (#1387).

`@oxagen/ingestion` and `@oxagen/github` share no dependency, so there was no
existing package that could hold this. It has no dependencies of its own, so
anything can take it.

`src/glob.test.ts` is a table. Add a row there rather than a case beside a call
site: it is the only place these semantics are written down.

## Not to be merged with

`matchGlob` in `@oxagen/mcp-config` matches flat values — MCP tool names and
URLs — where `*` is expected to cross every separator. A tool-name rule and a
path rule mean different things by the same character.

## Other globs in the tree

`@oxagen/ingestion` is the only package that imports this one today.

`globToRegex` in `packages/tacho/src/host/bundle.ts` matches the path rules in
Tacho's policy bundle. Tacho takes no `@oxagen/*` runtime dependency, so it
cannot import this package, so it writes out the same rules, `**/` as
`(?:.*/)?` included. Until 2026-09-23 it emitted `.*` there, so under Tacho
`**/.env` also matched `foo.env`. If you change a rule here, change it there
and add the row to both test tables.

## God files

None. Keep it that way; this package is one function and a table.
