# xmcp Migration Plan: `apps/mcp`

> Status: DRAFT — ready for implementation as a single PR  
> Last updated: 2026-05-30  
> Author: agent

---

## 1. Current State

`apps/mcp` is a hand-rolled MCP HTTP server built with:

| Layer | Technology |
|---|---|
| HTTP framework | Hono 4.x |
| HTTP server | `@hono/node-server` `serve()` — long-running Node process |
| MCP protocol adapter | NOT used — the app speaks a **custom HTTP JSON API**, not the MCP wire protocol |
| Transport | HTTP only; stdio is acknowledged as a future follow-up in `src/index.ts` |
| Tool registration | Automatic via `capabilitiesForSurface("mcp")` — the kernel registry drives discovery |
| Tool invocation | Single kernel `invoke()` path via `@oxagen/oxagen` |
| Auth/context | `placeholderContext()` — stub until auth subagent lands |
| Deployment target | `oxagen-v2-mcp` Vercel project (project ID `prj_0AQJiFXku3YUAi4TnQoR6KCvps2r`) |
| Dev command | `tsx watch --env-file=.env.local src/index.ts` |
| Build command | `tsc --noEmit` (type-check only; no real build artifact) |

### What currently lives in `src/tools/`

The 14 tool files in `src/tools/` were written before the current kernel-registry architecture. They are **dead code** — `server.ts` no longer imports them. The live server uses `capabilitiesForSurface("mcp")` + `invoke()` directly. The capability contracts live in `packages/oxagen/src/contracts/` (21 contracts, of which the `mcp` surface is flagged on at least 14).

**Critical constraint** (from `CLAUDE.md`): Every capability must be reachable identically from MCP, API, and in-app agent. Capability logic lives in `/packages`; each surface is a thin adapter. This constraint is already satisfied by the kernel approach and must be preserved in xmcp.

---

## 2. What xmcp Is

xmcp ([xmcp.dev](https://xmcp.dev), [github.com/basementstudio/xmcp](https://github.com/basementstudio/xmcp)) is a TypeScript-first framework from Basement Studio for building MCP-compatible backends. Latest release: **v0.6.10** (May 15, 2026).

Key properties relevant to this migration:

- **File-system routing**: TypeScript files placed in `src/tools/` are auto-discovered and registered as MCP tools.
- **Build output**: `xmcp build` compiles to `dist/http.js` (HTTP transport) and `dist/stdio.js` (stdio transport) using rspack under the hood.
- **Transports**: HTTP (Streamable HTTP — the current MCP spec transport) and stdio, configured in `xmcp.config.ts`. Both can be enabled simultaneously.
- **Vercel**: Zero-configuration deployment. Vercel has a first-class framework preset named **"xmcp"**. Endpoints run as Vercel Functions using Fluid compute. No `vercel.json` needed.
- **Dev command**: `xmcp dev` (hot reloading).
- **Tool shape**: three named exports per file — `schema` (plain object of Zod validators), `metadata` (name, description, annotations), and a `default` async function handler.
- **Auth/middleware**: `src/middleware.ts` exports a `Middleware` function or array. Built-in `apiKeyAuthMiddleware` and `jwtAuthMiddleware` are provided. Tools access per-request headers via `import { headers } from "xmcp/headers"`.
- **Context injection**: No explicit context parameter is threaded through tool signatures. Auth state and request headers are accessed inside tool functions via `headers()`. This requires a mapping strategy for the `CapabilityContext` the kernel needs (see Section 6).
- **Node engine**: `>=20.0.0` (from Vercel's official xmcp example `package.json`). The monorepo root already requires `>=22.11.0`, so Node 24 (set in Vercel project settings) is fully compatible.
- **Zod compatibility**: xmcp peer-depends on `zod ^3.25.76 || ^4.0.0`. The monorepo currently uses `zod ^3.23.8`. Upgrading to `^3.25.76` is required before adding xmcp.

Sources: [xmcp.dev/docs](https://xmcp.dev/docs) · [Vercel xmcp docs](https://vercel.com/docs/frameworks/backend/xmcp) · [Vercel changelog: deploy xmcp with zero configuration](https://vercel.com/changelog/deploy-xmcp-servers-with-zero-configuration) · [Vercel xmcp example](https://github.com/vercel/vercel/tree/main/examples/xmcp) · [xmcp GitHub](https://github.com/basementstudio/xmcp)

---

## 3. Target State

### 3.1 File Layout

```
apps/mcp/
├── xmcp.config.ts          # NEW — xmcp framework config
├── src/
│   ├── middleware.ts        # NEW — auth middleware (replaces placeholderContext)
│   ├── context.ts          # KEEP (or inline) — CapabilityContext builder
│   └── tools/              # ONE FILE PER CAPABILITY (replaces dead tool files)
│       ├── agent.tool.list.ts
│       ├── agent.mcp.list.ts
│       ├── agent.mcp.register.ts
│       ├── agent.memory.recall.ts
│       ├── agent.memory.write.ts
│       ├── agent.skill.list.ts
│       ├── agent.task.background.cancel.ts
│       ├── agent.task.background.read.ts
│       ├── agent.task.background.start.ts
│       ├── billing.subscription.read.ts
│       ├── billing.subscription.upgrade.start.ts
│       ├── chat.message.send.ts
│       ├── organization.create.ts
│       └── workspace.create.ts
├── package.json            # UPDATED (add xmcp, remove hono/@hono/node-server)
├── tsconfig.json           # UPDATED (target Node ESM, compatible with rspack bundler)
└── .env.local              # UNCHANGED
```

Files removed: `src/index.ts`, `src/server.ts`.

### 3.2 `xmcp.config.ts`

```typescript
// apps/mcp/xmcp.config.ts
import { type XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  http: true,
  // Enable stdio for local CLI/desktop MCP client support (Claude Desktop, etc.)
  // Output: dist/stdio.js  — run with: node dist/stdio.js
  stdio: {
    silent: true,
  },
};

export default config;
```

Source: [http example config](https://github.com/basementstudio/xmcp/blob/main/examples/http-transport/xmcp.config.ts) · [stdio example config](https://github.com/basementstudio/xmcp/blob/main/examples/stdio-transport/xmcp.config.ts)

### 3.3 Representative Tool: `agent.tool.list`

This example shows exactly how a tool delegates to the existing `@oxagen/agent` handler and `@oxagen/oxagen` contract, preserving the no-drift constraint.

```typescript
// apps/mcp/src/tools/agent.tool.list.ts
import { z } from "zod";
import { type InferSchema, type ToolMetadata, headers } from "xmcp";
import { agentToolList } from "@oxagen/oxagen/contracts/agent.tool.list";
import { agentToolListHandler } from "@oxagen/agent/handlers/agent.tool.list";
import { buildContext } from "../context.js";

// xmcp schema: plain object of Zod validators.
// Mirror the contract's input schema so xmcp validates before our handler runs.
export const schema = {
  includeExternal: z
    .boolean()
    .default(true)
    .describe("Include externally-registered tools"),
};

export const metadata: ToolMetadata = {
  name: agentToolList.name,           // "agent.tool.list"  — from the contract
  description: agentToolList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentToolListTool(
  args: InferSchema<typeof schema>,
) {
  // xmcp validates args against `schema` before calling this function.
  // Build CapabilityContext from request headers (replaces placeholderContext).
  const ctx = buildContext(headers());

  // Delegate to the shared handler in @oxagen/agent — same path as API surface.
  const output = await agentToolListHandler(args, ctx);

  // Return the validated output. xmcp serialises return values as MCP content.
  return agentToolList.output.parse(output);
}
```

The `buildContext` helper in `src/context.ts` replaces `placeholderContext()`:

```typescript
// apps/mcp/src/context.ts
import type { CapabilityContext } from "@oxagen/oxagen";

/**
 * Build a CapabilityContext from xmcp request headers.
 * Headers are set by the middleware after bearer-token / API-key validation.
 * Falls back to placeholder values until auth lands (matching current behaviour).
 */
export function buildContext(
  hdrs: Record<string, string | undefined>,
): CapabilityContext {
  return {
    orgId:        hdrs["x-oxagen-org-id"]       ?? "00000000-0000-0000-0000-000000000000",
    workspaceId:  hdrs["x-oxagen-workspace-id"] ?? "00000000-0000-0000-0000-000000000000",
    userId:       hdrs["x-oxagen-user-id"]      ?? null,
    apiKeyId:     hdrs["x-oxagen-api-key-id"]   ?? null,
    requestId:    hdrs["x-request-id"]          ?? crypto.randomUUID(),
    surface:      "mcp",
    messageId:    null,
  };
}
```

### 3.4 `src/middleware.ts` (Auth)

```typescript
// apps/mcp/src/middleware.ts
import { apiKeyAuthMiddleware, type Middleware } from "xmcp";

// Phase 1: API-key gate using the same env var as the API surface.
// Phase 2: Replace with JWT middleware once the IAM subagent lands.
export default apiKeyAuthMiddleware({
  headerName: "x-api-key",
  validateApiKey: async (apiKey) => {
    // TODO(auth): validate against @oxagen/database api_keys table
    return apiKey === process.env.MCP_API_KEY;
  },
}) satisfies Middleware;
```

Source: [middlewares-api-key example](https://github.com/basementstudio/xmcp/blob/main/examples/middlewares-api-key/src/middleware.ts)

---

## 4. Tool Mapping Table

Each row maps the current dead tool file → its xmcp equivalent. Since the current `server.ts` already bypasses the individual tool files and calls the kernel directly, the xmcp tool files effectively replace both the dead tool files AND the current inline kernel call in `server.ts`.

| Current `src/tools/` file | Capability contract (in `@oxagen/oxagen`) | Handler package | xmcp tool file (same path) |
|---|---|---|---|
| `agent.tool.list.ts` | `agent.tool.list` | `@oxagen/agent` | `agent.tool.list.ts` |
| `agent.mcp.list.ts` | `agent.mcp.list` | `@oxagen/agent` | `agent.mcp.list.ts` |
| `agent.mcp.register.ts` | `agent.mcp.register` | `@oxagen/agent` | `agent.mcp.register.ts` |
| `agent.memory.recall.ts` | `agent.memory.recall` | `@oxagen/agent` | `agent.memory.recall.ts` |
| `agent.memory.write.ts` | `agent.memory.write` | `@oxagen/agent` | `agent.memory.write.ts` |
| `agent.skill.list.ts` | `agent.skill.list` | `@oxagen/agent` | `agent.skill.list.ts` |
| `agent.task.background.cancel.ts` | `agent.task.background.cancel` | `@oxagen/agent` | `agent.task.background.cancel.ts` |
| `agent.task.background.read.ts` | `agent.task.background.read` | `@oxagen/agent` | `agent.task.background.read.ts` |
| `agent.task.background.start.ts` | `agent.task.background.start` | `@oxagen/agent` | `agent.task.background.start.ts` |
| `billing.subscription.read.ts` | `billing.subscription.read` | `@oxagen/handlers` | `billing.subscription.read.ts` |
| `billing.subscription.upgrade.start.ts` | `billing.subscription.upgrade.start` | `@oxagen/handlers` | `billing.subscription.upgrade.start.ts` |
| `chat.message.send.ts` | `chat.message.send` | `@oxagen/handlers` | `chat.message.send.ts` |
| `organization.create.ts` | `organization.create` | `@oxagen/handlers` | `organization.create.ts` |
| `workspace.create.ts` | `workspace.create` | `@oxagen/handlers` | `workspace.create.ts` |

**Note on the kernel path**: The current `server.ts` also registered capabilities via `capabilitiesForSurface("mcp")` and the side-effect imports (`@oxagen/handlers/register`, `@oxagen/agent/register`). In xmcp, the individual tool files replace both — each file imports its contract and handler directly. The side-effect imports (`/register`) are no longer needed because xmcp auto-discovers tools from the filesystem; each tool file's import chain pulls in the handler naturally.

**Capabilities not yet in the tool files** (in `packages/oxagen/src/contracts/` but not yet exposed on MCP surface): `agent.approval.resolve`, `agent.code.execute`, `agent.plan.approve`, `agent.plan.create`, `agent.skill.load`, `agent.subagent.aggregate`, `agent.subagent.dispatch`. These should be added as follow-up tool files when those contracts mark `"mcp"` in their `surfaces` array.

---

## 5. `package.json` Changes

```jsonc
{
  "name": "@oxagen/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  // Remove: "main" field (not needed; xmcp is the entry point)
  "scripts": {
    "dev":       "xmcp dev",
    "build":     "xmcp build",
    "start":     "node dist/http.js",
    "start:stdio": "node dist/stdio.js",
    "typecheck": "tsc --noEmit",
    "lint":      "echo 'lint placeholder'"
  },
  "dependencies": {
    // ADD
    "xmcp": "^0.6.10",
    // KEEP (workspace packages)
    "@oxagen/agent":    "workspace:*",
    "@oxagen/config":   "workspace:*",
    "@oxagen/database": "workspace:*",
    "@oxagen/handlers": "workspace:*",
    "@oxagen/oxagen":   "workspace:*",
    // KEEP
    "zod": "^3.25.76",    // bump from ^3.23.8 to satisfy xmcp peer dep
    // REMOVE
    // "@hono/node-server": "^1.13.1",
    // "hono": "^4.6.3"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    // ADD (xmcp uses swc/rspack under the hood but swc-loader may be needed)
    "swc-loader": "^0.2.6",
    // KEEP
    "typescript": "^6.0.3"
    // REMOVE
    // "tsx": "^4.19.1"  (no longer needed; xmcp dev/build owns the process)
  }
}
```

The `tsx` dev dependency can be removed because `xmcp dev` replaces `tsx watch`, and `xmcp build` replaces the manual `tsc` compilation. The `@hono/node-server` and `hono` packages are no longer needed.

---

## 6. Vercel Project Settings for `oxagen-v2-mcp`

Source: [Vercel xmcp docs](https://vercel.com/docs/frameworks/backend/xmcp) · [Vercel xmcp boilerplate](https://vercel.com/templates/backend/xmcp-boilerplate) · [Vercel changelog](https://vercel.com/changelog/deploy-xmcp-servers-with-zero-configuration)

| Setting | Value |
|---|---|
| **Framework Preset** | **`xmcp`** |
| **Root Directory** | `apps/mcp` |
| **Install Command** | `pnpm install --frozen-lockfile` |
| **Build Command** | `pnpm build` (executes `xmcp build`) |
| **Output Directory** | `dist` |
| **Node.js Version** | **24.x** |
| **vercel.json** | Not required — framework preset handles routing |

**Runtime**: Vercel Functions using **Fluid compute** (the default for xmcp on Vercel). Not Edge Runtime — xmcp targets Node.js, not the Edge runtime, which is important because `@oxagen/database` (Postgres/Drizzle) and `@oxagen/agent` are not Edge-compatible.

**HTTP Transport on Vercel**: xmcp uses **Streamable HTTP** transport (current MCP spec). The `/mcp` endpoint (configurable in `xmcp.config.ts` via `http.endpoint`) becomes a Vercel Function. MCP clients connect to `https://mcp.oxagen.sh/mcp`.

**pnpm monorepo note**: Vercel's `pnpm install` at the root of `apps/mcp` (with `Root Directory = apps/mcp`) will hoist workspace packages from `packages/*`. This works if the Vercel project's Root Directory is set to `apps/mcp` AND the workspace root `pnpm-workspace.yaml` and `pnpm-lock.yaml` are accessible. In practice, Vercel runs install at the repo root when it detects a monorepo (pnpm-workspace.yaml at root), so the workspace deps resolve correctly. No special `vercel.json` overrides are needed.

**Environment variables**: All existing env vars in the `oxagen-v2-mcp` Vercel project carry over unchanged. Add `MCP_API_KEY` for the middleware auth gate.

---

## 7. `tsconfig.json` Update

xmcp uses rspack (not tsc) for compilation, so `tsconfig.json` only needs to satisfy type-checking (`tsc --noEmit`). The `moduleResolution: "Bundler"` and `module: "ESNext"` settings are already correct. No changes required beyond confirming `"skipLibCheck": true` is set (inherited from `tsconfig.base.json`).

---

## 8. Step-by-Step Build Sequence

### Phase 0: Prerequisites (before any file edits)

1. Bump `zod` to `^3.25.76` workspace-wide (or just in `apps/mcp/package.json`). xmcp peer-requires `zod ^3.25.76 || ^4.0.0`.
2. Confirm Node 24 is active: `node --version` → `v24.x.x`.

### Phase 1: Add xmcp, remove Hono

3. Edit `apps/mcp/package.json`: add `xmcp`, remove `hono`/`@hono/node-server`/`tsx`, add `swc-loader` devDep, bump `zod`.
4. `pnpm install` from monorepo root.

### Phase 2: Create framework files

5. Create `apps/mcp/xmcp.config.ts` (Section 3.2).
6. Create `apps/mcp/src/middleware.ts` (Section 3.4).
7. Update `apps/mcp/src/context.ts` — replace `placeholderContext()` with `buildContext(headers: Record<string, string | undefined>)` (Section 3.3).

### Phase 3: Rewrite tool files

8. For each of the 14 tools in the mapping table (Section 4), rewrite `src/tools/<name>.ts` to the xmcp export shape: `schema`, `metadata`, `default` handler that calls `buildContext(headers())` and delegates to the package handler. See Section 3.3 for the template.

   Key differences from the old files:
   - No `McpTool` wrapper object.
   - No `invoke(raw)` — xmcp validates against `schema` first, then calls the `default` function with typed args.
   - No `import type { McpTool } from "../server.js"` (server.ts is deleted).
   - `schema` is a plain Zod object (not `z.object({...})`), matching the contract's input fields directly.

### Phase 4: Delete dead code

9. Delete `apps/mcp/src/index.ts` (Hono `serve()` entrypoint).
10. Delete `apps/mcp/src/server.ts` (Hono router + kernel bridge).

### Phase 5: Type-check and build locally

11. `pnpm -F @oxagen/mcp typecheck` — verify no TypeScript errors.
12. `pnpm -F @oxagen/mcp build` — should produce `dist/http.js` and `dist/stdio.js`.

### Phase 6: Local smoke test

13. **HTTP transport**: `pnpm -F @oxagen/mcp dev` (runs `xmcp dev`, starts on port 3000 by default or the port set in `xmcp.config.ts`).

   Test with an MCP client (e.g. the MCP Inspector):
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:3000/mcp
   ```
   - Verify the tool list includes all 14 tools.
   - Invoke `agent.tool.list` with `{"includeExternal": true}` — confirm the response matches the API surface output.

14. **stdio transport**: `node dist/stdio.js` — connect Claude Desktop or the MCP Inspector in stdio mode, verify tool discovery and a round-trip invocation.

### Phase 7: Vercel deploy

15. Update Vercel project settings (Section 6): set Framework Preset to `xmcp`, Root Directory to `apps/mcp`, Node 24.x, add `MCP_API_KEY` env var.
16. Push branch → Vercel preview deploy triggered.
17. Verify preview URL:
    - `GET https://<preview>.vercel.app/mcp` → should return MCP server info (or redirect to MCP handshake — behavior depends on xmcp version).
    - Connect MCP Inspector to the preview URL, invoke a read-only tool.
18. Merge to main → production deploy to `https://mcp.oxagen.sh`.

---

## 9. Risks and Mitigations

### Risk 1: `CapabilityContext` injection — no native context threading in xmcp

**Problem**: The current `invoke()` kernel and all `@oxagen/agent`/`@oxagen/handlers` functions require a `CapabilityContext` argument (`orgId`, `workspaceId`, `userId`, `apiKeyId`, `surface`, `requestId`). xmcp does not pass a context object to tool functions — auth state is communicated via HTTP headers.

**Mitigation**: The `buildContext(headers())` pattern in `src/context.ts` reconstructs `CapabilityContext` from request headers inside each tool's `default` function (Section 3.3). The middleware is responsible for validating the bearer token / API key and writing the resolved `orgId` / `workspaceId` / `userId` into custom response headers (`x-oxagen-org-id`, etc.) that the tool reads back. This is a one-time pattern that all 14 tools share identically.

**Phase 1 fallback**: While `placeholderContext()` is still in use (i.e. before the auth subagent lands), `buildContext` simply returns the same zeros — behaviour is identical to today. No regression.

### Risk 2: xmcp rspack bundler and `@oxagen/*` workspace packages

**Problem**: xmcp uses rspack (not tsc) to bundle `dist/http.js`. Rspack must be able to resolve workspace packages (`@oxagen/agent`, `@oxagen/database`, etc.) which are TypeScript source (not pre-compiled) in a pnpm workspace. Rspack may not follow `exports` maps or `tsconfig.paths` the same way tsc does.

**Mitigation**:
- All `@oxagen/*` packages already set `"type": "module"` and expose `dist/` compiled output. Ensure each package in the dependency chain has a valid `build` step so `dist/` exists before `xmcp build` runs.
- In Turbo pipeline, add `@oxagen/mcp#build` to depend on the `build` outputs of its workspace dependencies (already handled by the `dependsOn: ["^build"]` Turbo pattern if present).
- If rspack struggles with deep TypeScript source imports, set `typescript.skipTypeCheck: true` in `xmcp.config.ts` and rely on the separate `typecheck` script (which runs tsc).
- Test locally with `pnpm -F @oxagen/mcp build` before pushing to Vercel.

### Risk 3: Vercel Fluid compute and long-running database/Neo4j connections

**Problem**: xmcp on Vercel runs as Vercel Functions (Fluid compute). Unlike a long-running Node server, each function invocation may be a fresh process. Connection pooling for PostgreSQL (`@oxagen/database`) and Neo4j (`@oxagen/ontology`) that relies on module-level singleton connections will break if the connection is established at module load time but the module is evicted between requests.

**Mitigation**:
- Verify `@oxagen/database` uses a connection pool that reconnects on demand (e.g. `pg` pool or Drizzle with a connection string — Drizzle lazy-connects by default).
- Neo4j driver (`neo4j-driver`) should use `driver.session()` per-request, not a long-lived session.
- Fluid compute keeps functions warm between requests within a window, so pooled connections typically survive; but the code must handle reconnection gracefully.
- This is the same concern that exists for `apps/api` on Vercel — if it works there, it works here.

---

## 10. Auth / Context Injection in xmcp

The xmcp auth model is header-based. The flow:

```
MCP Client
  → sends:  Authorization: Bearer <token>  OR  x-api-key: <key>
  → Vercel Function receives request
  → xmcp calls src/middleware.ts first
  → middleware validates the token; on failure returns 401
  → on success, middleware calls next()
  → xmcp calls the tool's default function
  → tool calls headers() to get the raw headers
  → tool calls buildContext(headers()) to get CapabilityContext
  → tool calls handler(args, ctx)
```

The middleware can enrich headers before passing to next via the `res` object, or it can rely on the client sending identity headers (e.g. `x-oxagen-org-id`) alongside a valid API key. For Phase 1 (API key gate only), the middleware just validates `x-api-key` and the `buildContext` returns placeholder org/workspace IDs. For Phase 2 (IAM subagent), the middleware looks up the API key in the database, resolves the associated org/workspace, and sets `x-oxagen-org-id` etc. in the response headers before calling `next()`.

The existing `CapabilityContext` interface in `@oxagen/oxagen` is not changed. The tool files are the only new thin-adapter code.

---

## 11. stdio Transport — Local Desktop Clients

xmcp builds **both** `dist/http.js` and `dist/stdio.js` from a single `xmcp build` invocation when both `http: true` and `stdio: { ... }` are set in `xmcp.config.ts`.

```
# HTTP (Vercel / remote MCP clients)
node dist/http.js

# stdio (Claude Desktop, MCP Inspector local mode, terminal agents)
node dist/stdio.js
```

For Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "oxagen": {
      "command": "node",
      "args": ["/path/to/oxagen-monorepo/apps/mcp/dist/stdio.js"]
    }
  }
}
```

This satisfies the `src/index.ts` comment: "stdio mode is a follow-up once the SDK plumbing stabilizes." xmcp handles the MCP wire protocol for stdio natively — no `@modelcontextprotocol/sdk` wiring needed.

The current server speaks a **custom HTTP JSON API** (not the MCP wire protocol). After migration, both HTTP and stdio transports will speak proper MCP Streamable HTTP / stdio, making the server compatible with the full ecosystem of MCP clients without custom adapters.

---

## 12. `@oxagen/config` / `loadEnv()` Compatibility

The current `dev` script uses `tsx --env-file=.env.local`. xmcp loads env vars at module initialization via dotenv (visible in `packages/xmcp/src/index.ts` exports). xmcp's `dev` command respects `.env` and `.env.local` files automatically.

The `@oxagen/config` `loadEnv()` helper (which normalises over-quoted Vercel dev env values) is not directly called from `apps/mcp` today — it's called within the `@oxagen/database` and other packages when they initialize. This is unaffected by the xmcp migration. The `PORTS.mcp = 4100` constant from `@oxagen/config` is no longer used in the server entrypoint (xmcp owns the port); the `xmcp.config.ts` `http.port` field can be set to `4100` for local dev parity:

```typescript
const config: XmcpConfig = {
  http: {
    port: Number(process.env.MCP_PORT ?? 4100),
  },
  stdio: { silent: true },
};
```

---

## 13. Summary: What Changes, What Stays the Same

| Concern | Before | After |
|---|---|---|
| HTTP framework | Hono | xmcp (rspack-bundled Node function) |
| MCP wire protocol | Custom JSON API (non-MCP) | Proper Streamable HTTP MCP |
| stdio transport | Not implemented | `dist/stdio.js` via xmcp |
| Tool discovery | `capabilitiesForSurface("mcp")` kernel scan | xmcp file-system routing (`src/tools/`) |
| Tool invocation | `invoke()` kernel | Direct handler call inside tool `default` fn |
| Capability contracts | `@oxagen/oxagen/contracts/*` | **Unchanged** |
| Capability handlers | `@oxagen/agent`, `@oxagen/handlers` | **Unchanged** |
| Auth context | `placeholderContext()` | `buildContext(headers())` (same fallback values for now) |
| Vercel deploy | Custom Node build + no framework preset | xmcp framework preset, zero-config |
| Dev command | `tsx watch` | `xmcp dev` |
| Build artifact | `dist/` (tsc only, no bundle) | `dist/http.js` + `dist/stdio.js` (rspack bundle) |
| No-drift constraint | Satisfied via kernel | **Satisfied** — same handlers, same contracts |
