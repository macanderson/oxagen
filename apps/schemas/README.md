# @oxagen/schemas

Static host for Oxagen's public JSON Schemas, deployed to
[`schemas.oxagen.sh`](https://schemas.oxagen.sh). No framework, no build step —
`public/` is served as-is.

## What's hosted

Nothing yet. Each schema document lives at
`https://schemas.oxagen.sh/<name>.json` and is referenced from the
configuration file it describes:

```json
{
  "$schema": "https://schemas.oxagen.sh/<name>.json"
}
```

## Adding a schema

Drop the document in `public/`, give it a top-level `$id` equal to the URL it
is served under (`https://schemas.oxagen.sh/<file>`) plus a `title` and
`description`, and link it from `public/index.html`.

`src/hosted-schemas.test.ts` enforces exactly that: it fails if a hosted
document is invalid JSON, carries an `$id` that doesn't match where it is
served, or isn't listed on the index page — and equally if the index links a
document that isn't hosted.

```bash
pnpm --filter @oxagen/schemas test:unit
```

## Deploying

Deployed to Vercel as a static site (`vercel.json` sets `outputDirectory:
public` plus CORS + `Content-Type` headers on the JSON so editors can fetch
it cross-origin). The custom domain `schemas.oxagen.sh` is bound to the
`schemas-oxagen` Vercel project.
