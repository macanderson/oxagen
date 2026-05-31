# env-manager

A **local-only**, no-auth web UI to see every env var/secret per environment and
**deploy the right value to the right Vercel project + environment** in one click.
Binds to `127.0.0.1` only.

```bash
pnpm env:manager          # from repo root  →  http://127.0.0.1:7799
```

## What it does

- Reads the **catalog** (`src/catalog.ts`) — the single source of truth for
  *what env var goes where*: each var declares which **services** (Vercel
  projects) need it and where each environment's **value** comes from.
- Shows current Vercel state (which `key`/`target` are already set, per project).
- **Deploy `<env>`** resolves every var's value from its source and pushes it to
  each of its services' projects on that target. Values are piped server-side and
  **never sent to the browser**.

### Value sources (`sources` per environment)

| source | resolves via |
|---|---|
| `gsm` | `gcloud secrets versions access latest --secret=<name>` |
| `neon` | `neonctl connection-string --project-id <id>` |
| `generate` | fresh random hex (cached per key so api+app match within an env) |
| `static` | a literal baked into the catalog |
| `manual` | you set it yourself (Inngest/LLM dashboard keys) — shown but not auto-pushed |

Production pulls **live/prod** credentials; preview + development pull the
**dev/test** instances (Neon dev branch, Stripe test keys) — so preview branches
behave like local dev, not production.

## Config (env vars it reads)

| var | purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel API token (admin). **Required.** |
| `VERCEL_TEAM_ID` | team id (defaults to the oxagen team) |
| `VERCEL_PROJECT_API` / `_APP` / `_MCP` / `_WEBSITE` / `_ADMIN` / `_DOCS` | override the built-in project ids |
| `ENV_MANAGER_PORT` | port (default `7799`) |

Put these in the repo-root `.env.local`; `pnpm env:manager` loads it.

## Extending

- **New env var** → add a `CatalogEntry` to `src/catalog.ts`.
- **New provider** (today only Vercel) → add a client like `src/vercel.ts` and a
  branch in the deploy loop.
- **New value source** → add a `Source` variant in `src/types.ts` + a case in
  `src/sources.ts`.

## Notes

- Env changes only take effect on the **next deployment** — re-deploy the affected
  Vercel projects after a sync.
- Vercel's CLI can't set "all preview branches" non-interactively; this tool uses
  the REST API, which can (`target:["preview"]`, no `gitBranch`).
