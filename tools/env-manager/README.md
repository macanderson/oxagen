# env-manager

A **local-only**, no-auth web UI to see every env var/secret per environment and
**deploy the right value to the right Vercel project + environment** in one click.
Binds to `127.0.0.1` only.

```bash
pnpm env:manager          # from repo root  →  http://127.0.0.1:7799
```

## What it does

- Reads the **catalog** — derived automatically from `packages/config/src/registry.ts`,
  the single source of truth for *what env var goes where*. Each var declares which
  **services** (Vercel projects) need it and where each environment's value comes from.
- Shows **current Vercel state** (which `key`/`target` are already set, per project).
- **Deploy `<env>`** resolves every `static` and `generate` var's value and pushes it to
  each of its services' projects on that target. Values are piped server-side and
  **never sent to the browser**.
- **Paste-and-fan-out** (`manual` vars): paste or type a secret/API key into the inline
  input, click **Push → N** to write it to every dependent project in one shot. The value
  is never echoed back after submission.
- **Gaps `<env>`**: diffs the registry's *required* vars against what's actually set on
  Vercel for each service — surfaces missing required vars and unregistered Vercel vars.

### Value sources

| source | resolves via |
|---|---|
| `static` | a literal from the registry (per-env or shared `"*"`) |
| `generate` | fresh random hex, cached per (key, env) so api+app share one value |
| `manual` | you paste the value in the UI (Inngest keys, provider API keys, etc.) |

Production pulls *live/prod* credentials; preview + development pull *dev/test* instances
(Neon dev branch, Stripe test keys) so preview branches behave like local dev, not production.

## Config (env vars it reads)

| var | purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel API token (admin). **Required.** |
| `VERCEL_TEAM_ID` | team id (defaults to the oxagen team) |
| `VERCEL_PROJECT_API` / `_APP` / `_MCP` / `_WEBSITE` / `_ADMIN` / `_DOCS` | override the built-in project ids |
| `ENV_MANAGER_PORT` | port (default `7799`) |

Put these in the repo-root `.env.local`; `pnpm env:manager` loads it.

## Extending

- **New env var** → add an entry to `packages/config/src/registry.ts`. The catalog,
  `.env.example`, and the CI checker all derive from the registry automatically.
  Do **not** edit `src/catalog.ts` — it is generated.
- **New Vercel project** → add a `ServiceName` entry in `packages/config/src/registry.ts`
  and a project id default in `src/config.ts`.
- **New value source type** → add a `Source` variant in `src/types.ts` + a case in
  `src/sources.ts`.

## Notes

- Env changes only take effect on the **next deployment** — re-deploy the affected
  Vercel projects after a sync.
- Vercel's CLI can't set "all preview branches" non-interactively; this tool uses
  the REST API, which can (`target:["preview"]`, no `gitBranch`).
- The catalog is **read-only at runtime** — all routing metadata lives in the registry.
