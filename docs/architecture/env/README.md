# Environment Variable Architecture

## Mental model

An env var **belongs to the package that reads it**. A service (api, app, mcp, …)
needs the **union** of env vars required by every `@oxagen/*` package it
imports — directly or transitively.

### Old pattern (monolithic)

Every package called `loadEnv()`, which validated the _entire_ schema and
threw if any of the ~30 vars was absent. Importing `@oxagen/database` in a
test silently required `NEO4J_URI`, `STRIPE_SECRET_KEY`, etc. — vars the
database package never touches.

### New pattern (scoped)

Packages call `requireEnv([...only their keys])`. This builds a sub-schema
from `baseEnvSchema`, normalizes the env (quote-strip), and parses only the
requested fields. Missing or invalid values throw a clear error listing the
failing keys — nothing else in `process.env` is touched.

`loadEnv()` is still available for a full "validate everything" boot check.
Only `apps/api/src/index.ts` uses it, as an explicit gate-at-boot before the
HTTP server starts listening.

```ts
// ✓ New: validate only what you use
import { requireEnv } from "@oxagen/config/env";
const env = requireEnv(["DATABASE_URL", "NODE_ENV"] as const);
//   ^ typed as Pick<Env, "DATABASE_URL" | "NODE_ENV">

// ✓ Still available for full boot checks
import { loadEnv } from "@oxagen/config/env";
loadEnv(); // validates all ~30 vars, caches result
```

---

## Package → required env vars

| Package | Required keys | Notes |
|---------|--------------|-------|
| `@oxagen/database` | `DATABASE_URL`, `NODE_ENV` | `NODE_ENV` sets pool size |
| `@oxagen/telemetry` | `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` | Password defaults to `""` |
| `@oxagen/ontology` | `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` | Database defaults to `"neo4j"` |
| `@oxagen/auth` | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NODE_ENV` | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` read as optional |
| `@oxagen/billing` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` | `STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` read by client-side code in apps/app via `process.env` |
| `@oxagen/inngest-functions` | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (required in prod), `NODE_ENV` | Enforces prod requirement locally; base schema has both as optional |
| `@oxagen/ai` | `AI_GATEWAY_API_KEY` | Routes all AI calls (text, image, embeddings) through the Vercel AI Gateway; no direct-provider fallback |
| `@oxagen/agent` | Union of: `INNGEST_EVENT_KEY` (dispatch/handlers), `AI_GATEWAY_API_KEY` (embed), `DATABASE_URL` (approval), `SANDBOX_ENABLED` (materialize-tools) | Each file calls `requireEnv` for only its subset |
| `@oxagen/sandbox` | Reads `SANDBOX_DRIVER`, `MODAL_RUNNER_URL`, `MODAL_RUNNER_TOKEN`, `VERCEL_SANDBOX_TOKEN`, `VERCEL_SANDBOX_TEAM_ID`, `VERCEL_SANDBOX_PROJECT_ID` directly from `process.env` (not via `requireEnv`; vars are optional and auto-detected) | Vercel auth vars not needed on Vercel Functions (OIDC auto-resolves); required for local dev with `SANDBOX_DRIVER=vercel` |

---

## Service → full union of vars

Derived from each app's workspace dependencies and transitive requirements.

| Service | Packages used | Env vars needed |
|---------|--------------|-----------------|
| `apps/api` | database, billing, agent, inngest-functions, telemetry, config | `DATABASE_URL`, `NODE_ENV`, `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`, `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (prod), `AI_GATEWAY_API_KEY`¹, `SANDBOX_ENABLED`¹, `SANDBOX_DRIVER`¹, `VERCEL_SANDBOX_TOKEN`¹, `VERCEL_SANDBOX_TEAM_ID`¹, `VERCEL_SANDBOX_PROJECT_ID`¹ |
| `apps/app` | agent, auth, ai, database, billing (via route handlers) | `DATABASE_URL`, `NODE_ENV`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`¹, `GOOGLE_CLIENT_SECRET`¹, `GITHUB_CLIENT_ID`¹, `GITHUB_CLIENT_SECRET`¹, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`², `AI_GATEWAY_API_KEY`¹, `INNGEST_EVENT_KEY`¹, `SANDBOX_ENABLED`¹ |
| `apps/mcp` | agent, database, config | `DATABASE_URL`, `NODE_ENV`, `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `INNGEST_EVENT_KEY`, `AI_GATEWAY_API_KEY`¹, `SANDBOX_ENABLED`¹ |
| `apps/website` | ui (no `@oxagen/*` data packages) | None |
| `apps/admin` | ui (no `@oxagen/*` data packages) | None |
| `apps/cli` | config (PORTS only) | None (reads no data vars) |
| `apps/docs` | ui | None |

¹ Optional — service degrades gracefully when absent.  
² Client-side Next.js `NEXT_PUBLIC_` prefix required for browser exposure.

---

## How to add a new env var

1. **Add the field to `baseEnvSchema`** in `packages/config/src/env.ts`.
   - Use `z.string().optional()` if the var is not universally required.
   - Use a `z.string().startsWith(...)` or `.url()` refinement where the
     format is known and cheap to validate.
   - Add a comment citing the ticket that introduced it.

2. **Add the key to `requireEnv([...])` in the package that reads it.**
   Do not add it to packages that don't use it.

3. **Update this table** (Package → required vars and Service → full union).

4. **Set the var in every affected environment:**
   - `.env.local` for local dev (see `docker-compose.dev.yml` for service
     defaults).
   - Vercel dashboard for each `oxagen-v2-<app>` project that needs it.
   - CI secrets if tests require it.

5. **If the var is required in production for a specific package** (like the
   Inngest keys), enforce that in the package's initializer — not in the
   global `envSchema`. Follow the pattern in
   `packages/inngest-functions/src/inngest.ts::resolveInngestEnv`.

---

## Canonical Neo4j var names

The schema uses `NEO4J_URI` and `NEO4J_USERNAME` (not `NEO4J_URL` /
`NEO4J_USER`). Any `.env` file or infrastructure provisioning script must
use the canonical names.

## Stripe client-side key

`STRIPE_PUBLISHABLE_KEY` is the server-side name (validated by the schema,
available via `requireEnv`). The browser needs the `NEXT_PUBLIC_` prefix:
set **both** in Vercel:

```
STRIPE_PUBLISHABLE_KEY=pk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

`apps/app/src/lib/stripe.ts` reads `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and
falls back to `STRIPE_PUBLISHABLE_KEY` (server-side only, not exposed to the
browser in production Next.js builds).
