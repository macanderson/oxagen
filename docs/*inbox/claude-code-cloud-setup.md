# Claude Code on the web — optimal environment for `oxagen-monorepo`

How to configure a default **Claude Code on the web** (cloud sandbox) environment so it
works end-to-end on this repo. Verified against the official docs
(`code.claude.com/docs/en/claude-code-on-the-web`, `/web-quickstart`, `/settings`).

## How the cloud sandbox reads config

| Source                                                                                 | Where                           | Carries to cloud?                      |
| -------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| `.claude/settings.json`, `.claude/{skills,agents,commands}/`, `CLAUDE.md`, `.mcp.json` | repo clone                      | ✅ committed → auto-loaded             |
| **Setup script**, **environment variables**, **network allowlist**                     | claude.ai/code → Environment UI | ⚙️ UI-only, server-side (no repo file) |
| `~/.claude/*` (user-scope settings, skills, CLAUDE.md, `~/.claude.json` MCP)           | local machine                   | ❌ never reaches cloud                 |

So the repo already gives a cloud session its skills, agents, commands, hooks, MCP
declarations, and CLAUDE.md for free. The only things you set in the **web UI** are the
**setup script**, the **env vars**, and the **network access** level.

## One-time: connect the repo

1. Go to **[claude.ai/code](https://claude.ai/code)** → sign in.
2. Install the **Claude GitHub App** on the `oxagen-monorepo` repo (or run `/web-setup`
   from a local Claude Code terminal to sync your `gh` token). Git is done through
   Anthropic's proxy with scoped credentials — pushes are restricted to the session branch.

## Environment settings (the only UI you touch)

### 1) Setup script

```
bash tools/scripts/cloud-setup.sh
```

That script (committed at `tools/scripts/cloud-setup.sh`) pins **pnpm 11.7.0** via corepack
on the default **Node 24** image, runs `pnpm install`, and pre-pulls the three datastore
images so the per-session `pnpm dev` boot is fast. It runs **once** and is cached. It does
**not** start datastores or dev servers — the agent does that per session with `pnpm dev`
(the cache stores files, not running processes).

### 2) Network access — use **Custom** (Trusted defaults + the app's domains)

Default `Trusted` already allows npm, GitHub, and container registries. This repo also needs
egress to AI Gateway, Vercel, Linear, Stripe, PostHog, Blob, Modal, and AWS KMS. Set
**Network access → Custom**, keep the Trusted defaults, and add:

```
ai-gateway.vercel.sh
*.vercel.com
*.vercel.sh
api.linear.app
mcp.linear.app
api.stripe.com
*.posthog.com
*.blob.vercel-storage.com
*.modal.run
kms.us-east-2.amazonaws.com
```

(Drop any line for a service you won't exercise in cloud sessions — e.g. KMS/Modal.)

### 3) Environment variables

Cloud env vars are entered as `KEY=value` lines and are **visible to anyone who can edit
this environment** — there is no secrets store yet. Fastest correct path: **paste the
contents of root `.env.local`** (it already targets the in-sandbox Docker datastores), then:

- **Confirm the datastore URLs point at the sandbox's own Docker** (these are non-secret
  local creds from `docker-compose.dev.yml`):
  ```
  DATABASE_URL=postgresql://oxagen:oxagen@localhost:5433/oxagen
  CLICKHOUSE_URL=http://localhost:8123
  NEO4J_URI=bolt://localhost:7687
  NODE_ENV=development
  OXAGEN_LOCAL_DEV=true
  ```
- **Required for any LLM work:** `AI_GATEWAY_API_KEY` (all AI flows route through the Vercel
  AI Gateway — there are no per-provider keys).
- **Auth/crypto secrets** (`BETTER_AUTH_SECRET`, `AUTH_TOKEN_ENCRYPTION_KEY`,
  `INGESTION_ENCRYPTION_KEY`): the dev values in `.env.local` are fine for sandbox work.
- **Rotate or omit** anything you don't want visible to environment editors (prod tokens).
  Prefer dev/preview credentials over production ones in a shared environment.

## Caveats specific to this repo

- **MCP auth in headless cloud.** `.claude/settings.json` declares `github`, `linear`, and
  `vercel` MCP servers. `linear` (`mcp-remote`) and `vercel` use **interactive OAuth** and
  will **not** auto-authenticate in a cloud session. The `github` MCP needs
  `GITHUB_PERSONAL_ACCESS_TOKEN` set as an env var. Repo scripts that use `LINEAR_API_KEY`
  (REST) still work — only the Linear _MCP_ is affected.
- **Datastores per session.** Run `pnpm dev` (or the `oxagen-run` skill) to bring up Postgres
  :5433, Neo4j :7687, ClickHouse :8123 and all apps; the first compile is slow. `pnpm kill`
  tears it down.
- **Hooks run in cloud too.** The committed `PostToolUse`/`Stop` hooks (lint, telemetry,
  pre-commit `pnpm gate`) execute in the sandbox. The telemetry backfill self-skips when
  `PRODUCTION_ANALYTICS_*` is unset, so no prod writes happen by default.
- **Push policy still applies.** `CLAUDE.md` says **commit, never push to `main`.** A cloud
  session is isolated, so pushing a **feature branch** is safe, but integration to `main`
  stays manual (Mac, one push at a time, because the pre-push hook runs the unit-test gate).
- **Optional:** to auto-start datastores on every cloud session, add a `SessionStart` hook
  guarded by `CLAUDE_CODE_REMOTE` (set to `true` only in cloud) so it never fires locally:

  ```json
  "SessionStart": [{ "hooks": [{ "type": "command",
    "command": "[ \"$CLAUDE_CODE_REMOTE\" = \"true\" ] && pnpm dev >/dev/null 2>&1 & disown || true",
    "timeout": 30, "async": true }] }]
  ```

  Most workflows don't need this — the agent runs `pnpm dev` when it needs the stack.

## Verify the environment

In a fresh cloud session:

```bash
node -v && pnpm -v            # → v24.x, 11.7.0
pnpm install --frozen-lockfile   # → already satisfied (cached)
pnpm dev                      # datastores + apps come up; app :3000, api :4000, mcp :4100
pnpm gate                     # lint + typecheck + coverage + tests + migrations green
```
