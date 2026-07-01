# @oxagen/schemas

Static host for Oxagen's public JSON Schemas, deployed to
[`schemas.oxagen.sh`](https://schemas.oxagen.sh). No framework, no build step —
`public/` is served as-is.

## What's hosted

| File                                                                                   | Source of truth                       |
| --------------------------------------------------------------------------------------- | -------------------------------------- |
| [`oxagen-cli-settings-schema.json`](./public/oxagen-cli-settings-schema.json)            | `apps/cli/src/settings/schema.ts` (`oxagenSettingsSchema`) |

Reference it from an Oxagen CLI `settings.json` for editor autocompletion:

```json
{
  "$schema": "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json"
}
```

## Regenerating

The JSON Schema is generated from the canonical Zod schema — never hand-edit
`public/*.json`.

```bash
pnpm --filter @oxagen/schemas run settings:schema
```

`src/schema-drift.test.ts` regenerates the schema in-memory and fails if it
doesn't deep-equal the committed file, so CI catches any Zod change that
wasn't followed by a regeneration:

```bash
pnpm --filter @oxagen/schemas test:unit
```

## How it works

`scripts/generate.ts` imports `oxagenSettingsSchema` directly from
`apps/cli/src/settings/schema.ts` by relative path (the CLI package doesn't
export this module for import — there's exactly one copy of the schema, not a
duplicated one) and converts it with
[`zod-to-json-schema`](https://github.com/StefanTerdell/zod-to-json-schema),
adding a top-level `$id`, `title`, and `description`.

## Deploying

Deployed to Vercel as a static site (`vercel.json` sets `outputDirectory:
public` plus CORS + `Content-Type` headers on the JSON so editors can fetch
it cross-origin). The custom domain `schemas.oxagen.sh` is bound to the
`schemas-oxagen` Vercel project.
