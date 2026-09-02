# @oxagen/schemas

Static host for Oxagen's public JSON Schemas, deployed to
[`schemas.oxagen.sh`](https://schemas.oxagen.sh). There is no framework and no
build step — whatever is committed in `public/` is what gets served.

## What's hosted

| File                                                                         | Source of truth                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`oxagen-cli-settings-schema.json`](./public/oxagen-cli-settings-schema.json) | `apps/cli/src/settings/schema.ts` (`oxagenSettingsSchema`) |

Point an Oxagen CLI `settings.json` at it to get editor autocompletion:

```json
{
  "$schema": "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json"
}
```

## Regenerating

The JSON file is built from the Zod schema. Never hand-edit `public/*.json`.

```bash
pnpm --filter @oxagen/schemas run settings:schema
```

Run this from the repo root, or after a workspace-wide `pnpm i`. The generator
reads the CLI's source file directly, and that file imports
`@oxagen/mcp-config`, which only resolves out of `apps/cli/node_modules`. A
single-package install is not enough.

Right after a regen, `git diff` shows a large whitespace-only change. That is
expected: `JSON.stringify` puts each array item on its own line, and Biome (the
repo formatter) puts short arrays back on one line when you commit. The
meaningful comparison is the parsed JSON, which is what the drift test checks.

## The drift check, and what it does not cover

`src/schema-drift.test.ts` regenerates the schema in memory and fails if it
does not deep-equal the committed file:

```bash
pnpm --filter @oxagen/schemas test:unit
```

**This check does not fire on the change it exists to catch.** `package.json`
declares no dependency on `@oxagen/cli`, so a pull request that edits only
`apps/cli/src/settings/schema.ts` does not mark this package affected. CI's
PR job runs `turbo … --filter=...[origin/main]`, which then skips these tests
entirely. Push-to-main runs every package, but Turborepo hashes only this
package's own files, so a cached pass from an earlier run can be replayed even
though the Zod source moved.

Until that is fixed, run the drift test by hand whenever you touch
`oxagenSettingsSchema`.

## How it works

`scripts/generate.ts` imports `oxagenSettingsSchema` straight from
`apps/cli/src/settings/schema.ts` by relative path. The CLI package does not
export that module, and reading the file directly keeps one copy of the schema
instead of a second one that could drift. The script converts it with
[`zod-to-json-schema`](https://github.com/StefanTerdell/zod-to-json-schema)
and adds a top-level `$id`, `title`, and `description`.

Three consequences worth knowing:

- The Zod schema documents its fields in JSDoc comments, not `.describe()`
  calls. `zod-to-json-schema` only reads `.describe()`, so the generated file
  has no per-field descriptions and editors show no hover text.
- The root object is `.passthrough()`, which becomes
  `"additionalProperties": true`. Editors will not flag a misspelled key.
- The generated root is a `$ref` into `definitions`. Draft-07 tells validators
  to ignore any keyword sitting next to a `$ref`, so the `title` and
  `description` we add are decoration a strict validator drops. Editors follow
  the `$ref` and autocomplete correctly regardless.

## Deploying

Deployed to Vercel as a static site. `vercel.json` sets `outputDirectory` to
`public` and adds CORS plus `Content-Type` headers on the JSON so editors can
fetch it from any origin. The custom domain `schemas.oxagen.sh` is bound to the
`schemas-oxagen` Vercel project.

Nothing regenerates the schema at deploy time — Vercel ships the committed
bytes. A stale commit means a stale schema in every user's editor, and
`oxagen init` stamps that URL into every `settings.json` it writes
(`apps/cli/src/project/init.ts`).
