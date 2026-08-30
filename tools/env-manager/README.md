# env-manager

A **local-only**, no-auth web UI with two pages:

- `/` — see every env var per environment and **push the right value to the right
  Vercel project** in one click.
- `/secrets` — an editable spreadsheet over a local mirror of Google Cloud Secret
  Manager.

The server binds to `127.0.0.1` only. There is no login, so anything that can reach
the port can read every secret in the mirror. Do not port-forward it, do not expose
it through a tunnel, and stop it when you are done.

```bash
pnpm env:manager          # from repo root  →  http://127.0.0.1:7799
pnpm env:secrets:pull     # refresh the /secrets mirror from GCP
```

## What it does

- Reads the **catalog** — derived automatically from `packages/config/src/registry.ts`,
  the single source of truth for *what env var goes where*. Each var declares which
  **services** (Vercel projects) need it and where each environment's value comes from.
- Shows **current Vercel state** (which `key`/`target` are already set, per project).
- **Deploy `<env>`** resolves every `static` and `generate` var's value and pushes it to
  each of its services' projects on that target. On the `/` page these values stay on the
  server — they are never sent to the browser.
- **Paste-and-fan-out** (`manual` vars): paste or type a secret/API key into the inline
  input, click **Push → N** to write it to every dependent project in one shot. The value
  is never echoed back after submission.
- **Gaps `<env>`**: diffs the registry's *required* vars against what's actually set on
  Vercel for each service — surfaces missing required vars and unregistered Vercel vars.

### Value sources

| source | resolves via |
|---|---|
| `static` | a literal from the registry (per-env or shared `"*"`) |
| `generate` | fresh random hex, minted once per **Deploy** click so api+app get the same value |
| `manual` | you paste the value in the UI (Inngest keys, provider API keys, etc.) |

Production pulls *live/prod* credentials; preview + development pull *dev/test* instances
(Neon dev branch, Stripe test keys) so preview branches behave like local dev, not production.

> **`generate` overwrites, it does not top up.** Each **Deploy `<env>`** click mints a
> brand-new random value for every `generate` var and replaces whatever is live on that
> target. `BETTER_AUTH_SECRET` is one of them, so deploying production a second time
> signs out every production session. Push those vars with the paste input instead once
> they are set.

## The `/secrets` spreadsheet

`pnpm env:secrets:pull` copies every secret in the GCP project into `secrets.db`, a
SQLite file at the package root. It is gitignored and created mode `0600`, but it holds
**live secret values in plaintext**, so treat it exactly like `creds.txt`.

Each row has two kinds of column:

- **Machine columns** the pull refreshes every time: the active version, its date, and
  the value.
- **Human columns** you edit in the page: description, vendor URL, and which apps and
  packages use the secret. The value is editable too.

Editing any cell sets a lock on that column, and the next pull leaves locked columns
alone. That is what makes the pull safe to re-run forever.

Two things to know about the page:

- It **does** send plaintext secret values to your browser — that is what a spreadsheet
  of secrets is. Values render in password fields; the eye button reveals one.
- The value shown can come from `creds.txt` or `.env.local` rather than GCP when those
  files have a fresher match. The chip next to the key names the source it actually used.

## Config (env vars it reads)

| var | purpose |
|---|---|
| `VERCEL_TOKEN` | Vercel API token (admin). **Required.** |
| `VERCEL_TEAM_ID` | team id (defaults to the oxagen team) |
| `VERCEL_PROJECT_API` / `_APP` / `_MCP` / `_WEBSITE` / `_ADMIN` / `_DOCS` | override the built-in project ids |
| `ENV_MANAGER_PORT` | port (default `7799`) |
| `GCP_PROJECT` | GCP project the secrets pull reads (default `oxagen-490023`) |

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
- A push replaces a var by deleting the old entry and then creating a new one. Vercel
  has no transaction for this, so if the create half fails the variable is left unset
  rather than rolled back — check the log lines and re-push anything that errored.
