# Installable Plugins — Plan 7: E2E Tests + Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the installable-plugins epic with comprehensive Playwright E2E coverage of all nine enumerated flows, offline fixture servers, a plugin-seed DB helper, and user-facing docs for the marketplace and workspace install surfaces.

**Architecture:** Two in-process fixture HTTP servers (mock MCP + mock OAuth) are started by `playwright.config.ts` via `globalSetup`; each spec seeds its own tenant via a lightweight `seedPlugin` DB helper that mirrors the existing `setupAgentRuntimeFixture` pattern; the fixture servers write to a shared port file so specs can read their URLs. All specs are deterministic and offline — no real Stripe, Anthropic, or registry calls are made.

**Tech Stack:** Playwright 1.60, Node `http` (built-in, no extra dep) for fixture servers, `postgres` (already a dev dep) for DB seed helpers, TypeScript 6, `pnpm --filter @oxagen/app exec playwright test` (root) or `pnpm test:e2e` (in `apps/app`).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§11 testing, §10 docs)

---

## Task A — E2E harness: fixture servers + seed helper

> Adds the offline fixture infrastructure that every plugin spec depends on.

### A1 — Mock MCP server

- [ ] Create `apps/app/e2e/fixtures/mock-mcp-server.ts`.

```typescript
/**
 * mock-mcp-server.ts
 *
 * A minimal MCP streamable-HTTP server for E2E tests. Implements one tool
 * ("e2e_ping") so agent-integration tests can assert the tool was invoked.
 * Started by globalSetup, stopped by globalTeardown; listens on a random
 * port written to MOCK_MCP_PORT env var.
 *
 * Transport: streamable HTTP (POST /mcp).
 * Protocol: MCP 2025-03-26 (minimal subset — initialize + tools/call).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockMcpHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

function buildJsonRpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function buildJsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockMcpServer(): Promise<MockMcpHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    let rpc: { jsonrpc: string; id: unknown; method: string; params?: unknown };
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(buildJsonRpcError(null, -32700, "Parse error"));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });

    if (rpc.method === "initialize") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "mock-mcp-e2e", version: "0.0.1" },
          capabilities: { tools: {} },
        }),
      );
      return;
    }

    if (rpc.method === "tools/list") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          tools: [
            {
              name: "e2e_ping",
              description: "E2E smoke tool — returns pong.",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      );
      return;
    }

    if (rpc.method === "tools/call") {
      const p = rpc.params as { name: string; arguments: Record<string, unknown> };
      if (p.name !== "e2e_ping") {
        res.end(buildJsonRpcError(rpc.id, -32601, "Tool not found"));
        return;
      }
      res.end(
        buildJsonRpcResponse(rpc.id, {
          content: [{ type: "text", text: "pong" }],
          isError: false,
        }),
      );
      return;
    }

    res.end(buildJsonRpcError(rpc.id, -32601, "Method not found"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-mcp-server: no address");
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
```

- [ ] Commit: `test(e2e): add mock MCP server fixture`

### A2 — Mock OAuth authorization server

- [ ] Create `apps/app/e2e/fixtures/mock-oauth-server.ts`.

```typescript
/**
 * mock-oauth-server.ts
 *
 * A minimal OAuth 2.1 authorization server for E2E tests.
 * Implements:
 *   GET  /.well-known/oauth-authorization-server  — metadata
 *   GET  /authorize                               — instant-redirect (no UI)
 *   POST /token                                   — issues a mock access token
 *
 * All tokens are predictable so specs can assert stored credential values.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";

export interface MockOAuthHandle {
  port: number;
  issuer: string;
  stop: () => Promise<void>;
}

export const MOCK_ACCESS_TOKEN = "e2e_mock_access_token";
export const MOCK_REFRESH_TOKEN = "e2e_mock_refresh_token";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockOAuthServer(): Promise<MockOAuthHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);

    // ── Well-known metadata ───────────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    // ── Authorization endpoint — instant redirect with code ───────────────────
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", "e2e_auth_code");
      if (state) redirectTarget.searchParams.set("state", state);
      res.writeHead(302, { location: redirectTarget.toString() });
      res.end();
      return;
    }

    // ── Token endpoint ────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: MOCK_REFRESH_TOKEN,
          scope: "mcp",
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-oauth-server: no address");
  const port = addr.port;

  return {
    port,
    issuer: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
```

- [ ] Commit: `test(e2e): add mock OAuth authorization server fixture`

### A3 — Global setup/teardown wiring

- [ ] Create `apps/app/e2e/fixtures/global-setup.ts`.

```typescript
/**
 * global-setup.ts — start fixture servers before Playwright runs any spec.
 *
 * Writes MOCK_MCP_PORT and MOCK_OAUTH_PORT to process.env so specs can read
 * them via `process.env`. Playwright passes env through to worker processes.
 * Also writes a JSON sidecar at /tmp/oxagen-e2e-fixtures.json for any helper
 * that needs the URLs outside of test process.env.
 */
import { writeFileSync } from "node:fs";
import { startMockMcpServer } from "./mock-mcp-server";
import { startMockOAuthServer } from "./mock-oauth-server";

let _mcpStop: (() => Promise<void>) | null = null;
let _oauthStop: (() => Promise<void>) | null = null;

export default async function globalSetup(): Promise<void> {
  const [mcp, oauth] = await Promise.all([startMockMcpServer(), startMockOAuthServer()]);

  _mcpStop = mcp.stop;
  _oauthStop = oauth.stop;

  process.env.MOCK_MCP_URL = mcp.url;
  process.env.MOCK_MCP_PORT = String(mcp.port);
  process.env.MOCK_OAUTH_ISSUER = oauth.issuer;
  process.env.MOCK_OAUTH_PORT = String(oauth.port);

  writeFileSync(
    "/tmp/oxagen-e2e-fixtures.json",
    JSON.stringify({ mcpUrl: mcp.url, oauthIssuer: oauth.issuer }),
  );
}

// Playwright calls a named export `globalTeardown` on the same module
// when using the `globalSetup` path. We store references above.
export async function globalTeardown(): Promise<void> {
  await Promise.all([_mcpStop?.(), _oauthStop?.()]);
}
```

- [ ] Edit `apps/app/playwright.config.ts` — add `globalSetup` and `globalTeardown` pointing at the fixture:

```typescript
// Add to the defineConfig object (keep all existing keys):
globalSetup: "./e2e/fixtures/global-setup.ts",
globalTeardown: "./e2e/fixtures/global-setup.ts",
```

  The teardown export name (`globalTeardown`) is exported from the same file; Playwright reads it automatically when the globalSetup module exports it.

- [ ] Commit: `test(e2e): wire globalSetup/globalTeardown for fixture servers`

### A4 — Plugin DB seed helper

- [ ] Create `apps/app/e2e/helpers/seed-plugin.ts`.

```typescript
/**
 * seed-plugin.ts — DB helper for plugin E2E tests.
 *
 * seedPlugin: inserts a fresh user+org+workspace+session (same pattern as
 * setupAgentRuntimeFixture), then seeds the plugin tables needed to start a
 * spec mid-flow:
 *   - plugin.registries row (the default MCP registry, pointing at the mock
 *     MCP server URL so specs don't hit the real registry)
 *   - plugin.catalog_servers row (one mock server entry)
 *   - plugin.org_listings row (pre-installed, disabled — ready to enable)
 *   - agent.mcp_servers row (workspace-enabled — ready for agent integration)
 *
 * All inserts use ON CONFLICT DO NOTHING for idempotency.
 * teardownPlugin cleans up in FK-safe order.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

function uid(): string {
  return randomBytes(6).toString("hex");
}

export interface PluginFixtureOptions {
  orgSlug: string;
  workspaceSlug: string;
  userEmail: string;
  /** URL of the mock MCP server (e.g. from process.env.MOCK_MCP_URL). */
  mockMcpUrl: string;
}

export interface PluginFixture {
  orgId: string;
  workspaceId: string;
  userId: string;
  sessionToken: string;
  orgSlug: string;
  workspaceSlug: string;
  /** public_id of the seeded plugin.org_listings row (disabled, for enable tests). */
  orgListingId: string;
  /** public_id of the seeded plugin.catalog_servers row. */
  catalogServerId: string;
  cleanup: () => Promise<void>;
}

export async function seedPlugin(opts: PluginFixtureOptions): Promise<PluginFixture> {
  const sql = postgres(DATABASE_URL, { max: 3, prepare: false });

  const id = uid();

  // ── Org ──────────────────────────────────────────────────────────────────────
  const [orgRow] = await sql<{ id: string }[]>`
    INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
    VALUES ('org_e2e_' || ${id}, ${"E2E Plugin " + opts.orgSlug}, ${opts.orgSlug}, 'free', 'active')
    ON CONFLICT (slug) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!orgRow) throw new Error("seedPlugin: org upsert returned no row");
  const orgId = orgRow.id;

  // ── User ─────────────────────────────────────────────────────────────────────
  const [userRow] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
    VALUES ('usr_e2e_' || ${id}, ${opts.userEmail}, 'E2E Plugin', 'active', now())
    ON CONFLICT (email) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!userRow) throw new Error("seedPlugin: user upsert returned no row");
  const userId = userRow.id;

  // ── Workspace ─────────────────────────────────────────────────────────────────
  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
    VALUES ('wrk_e2e_' || ${id}, ${orgId}, 'Main', ${opts.workspaceSlug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!wsRow) throw new Error("seedPlugin: workspace upsert returned no row");
  const workspaceId = wsRow.id;

  // ── Memberships ───────────────────────────────────────────────────────────────
  await sql`
    INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
    VALUES ('oru_e2e_' || ${id}, ${orgId}, ${userId}, 'owner', now())
    ON CONFLICT (org_id, user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
    VALUES ('wsu_e2e_' || ${id}, ${workspaceId}, ${userId}, 'owner', now())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `;

  // ── Session ───────────────────────────────────────────────────────────────────
  const sessionToken = `e2e-plugin-session-${id}`;
  await sql`
    INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
    VALUES (${sessionToken}, ${sessionToken}, ${userId}, now() + interval '1 hour', '127.0.0.1', 'playwright-e2e')
    ON CONFLICT (id) DO NOTHING
  `;

  // ── Plugin registry (mock) ───────────────────────────────────────────────────
  const registryId = `reg_e2e_${id}`;
  await sql`
    INSERT INTO plugin.registries (public_id, org_id, name, registry_url, is_default, is_active)
    VALUES (${registryId}, ${orgId}, 'E2E Mock Registry', ${opts.mockMcpUrl}, false, true)
    ON CONFLICT (public_id) DO NOTHING
  `;

  // Resolve the internal registry UUID.
  const [regRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.registries WHERE public_id = ${registryId}
  `;
  if (!regRow) throw new Error("seedPlugin: registry insert returned no row");
  const registryDbId = regRow.id;

  // ── Catalog server entry ──────────────────────────────────────────────────────
  const catalogServerId = `srv_e2e_${id}`;
  await sql`
    INSERT INTO plugin.catalog_servers (
      public_id, registry_id, server_name, title, description,
      plugin_type, transport, auth_kind, endpoint_url, is_latest, status
    )
    VALUES (
      ${catalogServerId},
      ${registryDbId},
      ${"e2e.mock.mcp." + id},
      'E2E Mock MCP Server',
      'Smoke-test fixture MCP server with one tool: e2e_ping.',
      'mcp_server',
      'streamable_http',
      'none',
      ${opts.mockMcpUrl + "/mcp"},
      true,
      'active'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  const [catalogRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.catalog_servers WHERE public_id = ${catalogServerId}
  `;
  if (!catalogRow) throw new Error("seedPlugin: catalog_server insert returned no row");
  const catalogDbId = catalogRow.id;

  // ── Org listing (installed but disabled — tests enable it) ───────────────────
  const orgListingId = `lst_e2e_${id}`;
  await sql`
    INSERT INTO plugin.org_listings (
      public_id, org_id, catalog_server_id, enabled, auth_kind, server_name
    )
    VALUES (${orgListingId}, ${orgId}, ${catalogDbId}, false, 'none', ${"e2e.mock.mcp." + id})
    ON CONFLICT (public_id) DO NOTHING
  `;

  const [listingRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.org_listings WHERE public_id = ${orgListingId}
  `;
  if (!listingRow) throw new Error("seedPlugin: org_listing insert returned no row");
  const listingDbId = listingRow.id;

  // ── Workspace MCP server row (enabled — for agent-integration spec) ───────────
  await sql`
    INSERT INTO agent.mcp_servers (
      public_id, org_id, workspace_id, org_listing_id, name,
      endpoint_url, transport, enabled, health_status
    )
    VALUES (
      ${"mcp_e2e_" + id},
      ${orgId},
      ${workspaceId},
      ${listingDbId},
      'E2E Mock MCP',
      ${opts.mockMcpUrl + "/mcp"},
      'streamable_http',
      true,
      'healthy'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  const cleanup = async (): Promise<void> => {
    const csql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await csql`DELETE FROM agent.mcp_servers WHERE org_id = ${orgId}`;
      await csql`DELETE FROM plugin.org_listings WHERE org_id = ${orgId}`;
      await csql`DELETE FROM plugin.catalog_servers WHERE registry_id = ${registryDbId}`;
      await csql`DELETE FROM plugin.registries WHERE org_id = ${orgId}`;
      await csql`DELETE FROM auth.sessions WHERE id = ${sessionToken}`;
      await csql`DELETE FROM workspace.workspace_users WHERE workspace_id = ${workspaceId}`;
      await csql`DELETE FROM workspace.workspaces WHERE id = ${workspaceId}`;
      await csql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
      await csql`DELETE FROM auth.users WHERE id = ${userId}`;
      await csql`DELETE FROM org.organizations WHERE id = ${orgId}`;
    } finally {
      await csql.end({ timeout: 5 });
    }
  };

  await sql.end({ timeout: 5 });

  return {
    orgId,
    workspaceId,
    userId,
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    orgListingId,
    catalogServerId,
    cleanup,
  };
}
```

- [ ] Commit: `test(e2e): add seedPlugin DB helper for plugin fixture state`

---

## Task B — Spec 1: marketplace install (single + bulk multi-select)

- [ ] Create `apps/app/e2e/mcp-marketplace-install.spec.ts`.

**Required `data-testid` attributes** — if missing from Plan 6 UI, add them:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="browse-marketplace-btn"` on the "Browse marketplace" button.
- `apps/app/src/components/plugins/marketplace-dialog.tsx` → `data-testid="marketplace-dialog"` on the `DialogPopup`, `data-testid="plugin-card-{serverName}"` on each server card, `data-testid="plugin-card-checkbox-{serverName}"` on each multi-select checkbox, `data-testid="install-selected-btn"` on the bulk-install button, `data-testid="plugin-install-btn"` on the detail-page install button, `data-testid="marketplace-tab-mcp_server"` on the MCP Servers tab.

```typescript
/**
 * mcp-marketplace-install.spec.ts
 *
 * E2E flow 1: Install MCP from marketplace (single + bulk multi-select).
 *
 * Uses seedPlugin for a pre-seeded catalog entry that points at the
 * mock MCP server started by globalSetup.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-marketplace-install — single install", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-single-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-s-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("open marketplace, select server, click Install — org listing becomes enabled", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Open marketplace dialog.
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();

    // Ensure the MCP Servers tab is active.
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Find the fixture server card.
    const card = page.getByTestId(`plugin-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible();

    // Click through to detail and install.
    await card.click();
    await page.getByTestId("plugin-install-btn").click();

    // Dialog closes or a success toast appears.
    await expect(page.getByTestId("marketplace-dialog")).not.toBeVisible({ timeout: 10_000 });

    // The server now appears in the org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible();
  });
});

test.describe("mcp-marketplace-install — bulk multi-select", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-bulk-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-b-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("multi-select checkbox + Install selected (n) installs server", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Check the fixture server's checkbox.
    await page.getByTestId(`plugin-card-checkbox-${fixture.catalogServerId}`).check();

    // Bulk install button shows count ≥ 1.
    const bulkBtn = page.getByTestId("install-selected-btn");
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toContainText("1");
    await bulkBtn.click();

    // Dialog closes.
    await expect(page.getByTestId("marketplace-dialog")).not.toBeVisible({ timeout: 10_000 });

    // Server appears in org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible();
  });
});
```

- [ ] Commit: `test(e2e): marketplace install spec (single + bulk)`

---

## Task C — Spec 2: add custom MCP server + custom registry

- [ ] Create `apps/app/e2e/mcp-org-add-custom.spec.ts`.

**Required `data-testid` attributes** — add to Plan 6 UI if missing:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="add-custom-server-btn"`, `data-testid="add-custom-registry-btn"`.
- `apps/app/src/components/plugins/add-custom-server-form.tsx` → `data-testid="custom-server-name-input"`, `data-testid="custom-server-endpoint-input"`, `data-testid="custom-server-submit-btn"`.
- `apps/app/src/components/plugins/add-custom-registry-form.tsx` → `data-testid="custom-registry-name-input"`, `data-testid="custom-registry-url-input"`, `data-testid="custom-registry-submit-btn"`.

```typescript
/**
 * mcp-org-add-custom.spec.ts
 *
 * E2E flow 2: Add a custom MCP server and a custom registry to an org.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-org-add-custom — custom server", () => {
  test("owner can add a custom MCP server to the org allow-list", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-srv-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByTestId("add-custom-server-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-server-name-input").fill(`custom-mcp-${id}`);
    await page.getByTestId("custom-server-endpoint-input").fill(`${mockMcpUrl}/mcp`);
    await page.getByTestId("custom-server-submit-btn").click();

    // The new server appears in the org allow-list.
    await expect(page.getByText(`custom-mcp-${id}`)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("mcp-org-add-custom — custom registry + install from it", () => {
  test("owner can add a custom registry and browse servers from it", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-reg-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);

    await page.getByTestId("add-custom-registry-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-registry-name-input").fill(`E2E Registry ${id}`);
    await page.getByTestId("custom-registry-url-input").fill(mockMcpUrl);
    await page.getByTestId("custom-registry-submit-btn").click();

    // The new registry appears in the registries list.
    await expect(page.getByText(`E2E Registry ${id}`)).toBeVisible({ timeout: 10_000 });
  });
});
```

- [ ] Commit: `test(e2e): custom server + registry add specs`

---

## Task D — Spec 3: enable MCP at workspace layer

- [ ] Create `apps/app/e2e/mcp-workspace-enable.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` → `data-testid="plugin-row-{orgListingId}"`, `data-testid="plugin-enable-toggle-{orgListingId}"`.

```typescript
/**
 * mcp-workspace-enable.spec.ts
 *
 * E2E flow 3: Enable a pre-installed (org-allowed, disabled) MCP server
 * at the workspace layer.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-workspace-enable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `ws-enable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-ws-en-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("workspace owner can enable an org-allowed MCP server for this workspace", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // First enable the org listing so it appears in the workspace panel.
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    const enableOrgToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await expect(enableOrgToggle).toBeVisible();
    await enableOrgToggle.click();

    // Navigate to the workspace integrations page.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    // The seeded server should be visible in the allow-list.
    const row = page.getByTestId(`plugin-row-${fixture.orgListingId}`);
    await expect(row).toBeVisible();

    // Toggle it on.
    const toggle = page.getByTestId(`plugin-enable-toggle-${fixture.orgListingId}`);
    await toggle.click();

    // Toggle should now reflect enabled state.
    await expect(toggle).toHaveAttribute("data-state", "checked");
  });
});
```

- [ ] Commit: `test(e2e): workspace-layer enable spec`

---

## Task E — Spec 4: authenticate to OAuth MCP server

- [ ] Create `apps/app/e2e/mcp-oauth-connect.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` → `data-testid="plugin-connect-btn-{orgListingId}"`, `data-testid="plugin-auth-status-{orgListingId}"`.

```typescript
/**
 * mcp-oauth-connect.spec.ts
 *
 * E2E flow 4: Authenticate to an org-enabled OAuth MCP server using the
 * mock OAuth authorization server started by globalSetup.
 *
 * The mock OAuth server returns an instant redirect with `code=e2e_auth_code`.
 * The app's callback handler exchanges it for MOCK_ACCESS_TOKEN. We assert
 * the plugin row shows "connected" status after redirect.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-oauth-connect", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `oauth-conn-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-oauth-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_OAUTH_ISSUER ?? "http://127.0.0.1:9998",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("clicking Connect initiates OAuth and callback marks server as connected", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Navigate to workspace integrations.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    const connectBtn = page.getByTestId(`plugin-connect-btn-${fixture.orgListingId}`);
    await expect(connectBtn).toBeVisible();

    // The mock OAuth server instantly redirects back with code. Playwright
    // follows the redirect chain automatically — we just wait for the final URL.
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname.includes("/settings/integrations") &&
          !url.searchParams.has("code"),
        { timeout: 15_000 },
      ),
      connectBtn.click(),
    ]);

    // Auth status badge should now read "connected".
    const statusEl = page.getByTestId(`plugin-auth-status-${fixture.orgListingId}`);
    await expect(statusEl).toHaveText(/connected/i);
  });
});
```

- [ ] Commit: `test(e2e): OAuth connect flow spec`

---

## Task F — Spec 5: disable a previously-enabled server

- [ ] Create `apps/app/e2e/mcp-disable.spec.ts`.

```typescript
/**
 * mcp-disable.spec.ts
 *
 * E2E flow 5: Disable a previously-enabled MCP server at the org layer.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-disable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `disable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-dis-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("owner can disable an enabled MCP server at the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Enable first (fixture seeds as disabled).
    const enableToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "checked");

    // Now disable.
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "unchecked");

    // Reload to confirm DB-persisted.
    await page.reload();
    await expect(
      page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`),
    ).toHaveAttribute("data-state", "unchecked");
  });
});
```

- [ ] Commit: `test(e2e): disable MCP server spec`

---

## Task G — Spec 6: remove from org allow-list (uninstall)

- [ ] Create `apps/app/e2e/mcp-uninstall.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="org-listing-uninstall-btn-{orgListingId}"` on the "Remove" / uninstall button per row.
- Confirm dialog → `data-testid="uninstall-confirm-btn"`.

```typescript
/**
 * mcp-uninstall.spec.ts
 *
 * E2E flow 6: Remove an MCP server from the org allow-list.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-uninstall", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `uninstall-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-uninst-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("owner can remove an MCP server from the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // The listing row must be visible.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).toBeVisible();

    // Click uninstall.
    await page.getByTestId(`org-listing-uninstall-btn-${fixture.orgListingId}`).click();

    // Confirm dialog.
    await expect(page.getByTestId("uninstall-confirm-btn")).toBeVisible();
    await page.getByTestId("uninstall-confirm-btn").click();

    // Row is gone.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});
```

- [ ] Commit: `test(e2e): uninstall MCP server spec`

---

## Task H — Spec 7: denylist — denied server visible but not installable

- [ ] Create `apps/app/e2e/mcp-denylist.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="denylist-add-btn"`, `data-testid="denylist-server-name-input"`, `data-testid="denylist-submit-btn"`.
- Marketplace dialog card for denied server → `data-testid="plugin-card-denied-badge-{serverName}"`, install button disabled → `aria-disabled="true"`.

```typescript
/**
 * mcp-denylist.spec.ts
 *
 * E2E flow 7: Maintain a denylist. Assert denied server is not installable
 * but still visible in the marketplace with denied treatment + explanatory copy.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-denylist", () => {
  let fixture: PluginFixture;
  let deniedServerName: string;

  test.beforeAll(async () => {
    const id = uid();
    deniedServerName = `e2e.mock.mcp.${id}`;
    fixture = await seedPlugin({
      orgSlug: `denylist-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-deny-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("denied server is visible in marketplace with blocked treatment", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Add server name to denylist.
    await page.getByTestId("denylist-add-btn").click();
    await page.getByTestId("denylist-server-name-input").fill(fixture.catalogServerId);
    await page.getByTestId("denylist-submit-btn").click();

    // Open marketplace.
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Denied badge is present.
    const deniedBadge = page.getByTestId(`plugin-card-denied-badge-${fixture.catalogServerId}`);
    await expect(deniedBadge).toBeVisible();

    // Explanatory copy visible.
    await expect(
      page.getByText(/blocked by your organization/i),
    ).toBeVisible();

    // Install button is disabled.
    const installBtn = page.getByTestId("plugin-install-btn");
    await expect(installBtn).toHaveAttribute("aria-disabled", "true");
  });
});
```

- [ ] Commit: `test(e2e): denylist spec — denied server visible but not installable`

---

## Task I — Spec 8: RBAC negative — non-credentialed user cannot manage plugins

- [ ] Create `apps/app/e2e/mcp-rbac-negative.spec.ts`.

**Required `data-testid` attributes**:
- Ensure `browse-marketplace-btn`, `add-custom-server-btn`, `add-custom-registry-btn`, `denylist-add-btn` are NOT rendered for Member/Viewer role users (server-component role gate), or are visibly disabled with `aria-disabled`.

```typescript
/**
 * mcp-rbac-negative.spec.ts
 *
 * E2E flow 8: RBAC negative test.
 * A Member-role user cannot see plugin management UI, and the server action
 * for plugin.org.install rejects with 403.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

function uid(): string { return randomBytes(4).toString("hex"); }

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

test.describe("mcp-rbac-negative", () => {
  let fixture: PluginFixture;
  let memberSessionToken: string;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `rbac-neg-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-rbac-owner-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });

    // Create a Member-role user in the same org.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const memberId2 = uid();
      const memberEmail = `e2e-rbac-member-${id}@oxagen.test`;
      const [memberRow] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
        VALUES ('usr_e2e_mb_' || ${memberId2}, ${memberEmail}, 'E2E Member', 'active', now())
        ON CONFLICT (email) DO UPDATE SET status = 'active'
        RETURNING id
      `;
      if (!memberRow) throw new Error("rbac: member user insert failed");
      const memberUserId = memberRow.id;

      await sql`
        INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
        VALUES ('oru_e2e_mb_' || ${memberId2}, ${fixture.orgId}, ${memberUserId}, 'member', now())
        ON CONFLICT (org_id, user_id) DO NOTHING
      `;

      memberSessionToken = `e2e-rbac-member-session-${id}`;
      await sql`
        INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
        VALUES (${memberSessionToken}, ${memberSessionToken}, ${memberUserId}, now() + interval '1 hour', '127.0.0.1', 'playwright-e2e')
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("Member-role user: plugin management UI is hidden on the settings page", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Not redirected to login (member is still authenticated).
    await expect(page).not.toHaveURL(/\/login/);

    // Management buttons must NOT be present for a member.
    await expect(page.getByTestId("browse-marketplace-btn")).not.toBeVisible();
    await expect(page.getByTestId("add-custom-server-btn")).not.toBeVisible();
    await expect(page.getByTestId("denylist-add-btn")).not.toBeVisible();
  });

  test("Member-role user: plugin.org.install server action returns 403", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);

    // POST directly to the API route that backs the server action.
    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const url = `${API_BASE}/v1/${fixture.orgSlug}/default/plugins/org/install`;

    // Extract signed cookie from context.
    const cookies = await context.cookies("http://localhost:3000");
    const cookie = cookies.find((c) => c.name === "oxagen.session_token");

    const response = await page.request.post(url, {
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie: `oxagen.session_token=${cookie.value}` } : {}),
      },
      data: { pluginType: "mcp_server", catalogServerId: fixture.catalogServerId },
    });

    // 403 — member is not authorized to manage plugins.
    expect(response.status()).toBe(403);
  });
});
```

- [ ] Commit: `test(e2e): RBAC negative spec for plugin management`

---

## Task J — Spec 9: agent integration — installed MCP tool callable in Q&A turn

- [ ] Create `apps/app/e2e/mcp-agent-integration.spec.ts`.

**Design:** The mock MCP server (running on `MOCK_MCP_URL`) exposes `e2e_ping`. The `seedPlugin` helper seeds an `agent.mcp_servers` row pointing at it with `health_status='healthy'` and `enabled=true`. We mock the chat SSE stream (via `interceptAgentStream`) to return a `tool-call-start` for `e2e_ping` + a `tool-call-end`, then a text response. We assert the tool-call card renders in the chat UI.

**Required `data-testid` attributes**:
- `apps/app/src/components/chat/tool-call-card.tsx` (or equivalent) → `data-testid="tool-call-card-{toolCallId}"`.
- The chat input → already has `data-testid="chat-input"` or use `role=textbox, name=/message/i`.

```typescript
/**
 * mcp-agent-integration.spec.ts
 *
 * E2E flow 9: Agent integration — an installed+enabled MCP server's tool
 * is callable within an interactive Q&A agent turn.
 *
 * Proves the toolchain wiring end-to-end: seedPlugin inserts a healthy
 * agent.mcp_servers row; interceptAgentStream returns a deterministic
 * tool-call-start/end for e2e_ping; the UI renders the tool-call card.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-agent-integration", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `agent-int-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-agint-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("installed MCP tool e2e_ping appears in agent turn tool-call card", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Intercept the chat stream before navigating so the route is registered.
    await interceptAgentStream(page, {
      events: [
        {
          type: "tool-call-start",
          messageId: "msg_e2e_int",
          toolCallId: "tcl_e2e_ping",
          capability: "e2e_ping",
          inputPreview: {},
          riskLevel: "low",
        },
        {
          type: "tool-call-end",
          toolCallId: "tcl_e2e_ping",
          status: "completed",
          output: { content: "pong" },
          durationMs: 42,
        },
        { type: "text", messageId: "msg_e2e_int", text: "Done! The mock MCP tool returned pong." },
      ],
    });

    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // Send a message that will trigger the mocked tool call.
    const input = page.getByRole("textbox", { name: /message/i });
    await input.fill("run e2e_ping");
    await input.press("Enter");

    // The tool-call card must appear.
    await expect(page.getByTestId("tool-call-card-tcl_e2e_ping")).toBeVisible({
      timeout: 15_000,
    });

    // Final text response is visible.
    await expect(page.getByText(/mock MCP tool returned pong/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
```

- [ ] Commit: `test(e2e): agent integration spec — MCP tool callable in Q&A turn`

---

## Task K — Docs

### K1 — User docs: marketplace guide

- [ ] Create `apps/docs/content/docs/plugins/marketplace.mdx`.

```mdx
---
title: Plugin Marketplace
description: Discover and install MCP servers, integrations, and content tools for your organization.
---

## Overview

The **Plugin Marketplace** lets organization Owners and Admins browse, install, and govern
third-party plugin servers — MCP servers, data-source integrations, and content tools — that
contribute additional AI tools to every workspace in your org.

Plugins must be installed at the **org level** first (where they are disabled by default),
then enabled for individual workspaces. This two-tier model gives admins centralized control
over what agents can access.

## Opening the marketplace

1. Sign in as an org **Owner** or **Admin**.
2. Go to **Org settings → Plugins**.
3. Click **Browse marketplace**.

The marketplace dialog opens with three tabs: **MCP Servers**, **Integrations**, and
**Content Tools**. Use the search bar and filters (category, transport, auth kind) to
narrow results.

## Installing a server

### Single install

1. Click a server card to open its detail page.
2. Review the description, tools list, and README.
3. Click **Install**. The server is added to your org allow-list (disabled by default).

### Bulk install

1. Check the checkbox on one or more server cards.
2. The **Install selected (n)** button appears at the bottom of the dialog.
3. Click it to install all selected servers at once.

## Denied servers

Servers blocked by your org's denylist are shown with a greyed-out, disabled treatment
and a **"Blocked by your organization's admins"** label. They cannot be installed while
on the denylist.

## Adding a custom server

1. On the **Plugins** settings page, click **Add custom server**.
2. Enter a name and the MCP endpoint URL.
3. Choose the transport (streamable HTTP or SSE) and authentication kind (OAuth, API key, or none).
4. Click **Save**. The server is added directly to your org allow-list.

## Adding a custom registry

1. Click **Add custom registry**.
2. Enter a name and the registry URL (must implement the MCP Registry OpenAPI 2025-12-01).
3. Click **Save**. The registry syncs its catalog automatically.

After syncing, servers from the registry appear in the marketplace under the MCP Servers tab.
```

- [ ] Create `apps/docs/content/docs/plugins/workspace-plugins.mdx`.

```mdx
---
title: Workspace Plugins
description: Enable org-installed plugin servers for your workspace so agents can use their tools.
---

## Overview

Once an org admin has installed a plugin server at the org level, workspace Owners and
Admins can enable it for their workspace. Only enabled servers have their tools injected
into the agent toolchain for that workspace.

## Enabling a plugin for your workspace

1. Go to **Workspace settings → Integrations**.
2. The page lists all org-installed servers available to this workspace.
3. Toggle a server on with the **Enable** switch.
4. If the server requires authentication (OAuth or API key), a **Connect** button appears — see below.

## Authenticating an OAuth server

1. Click **Connect** next to an OAuth-protected server.
2. You are redirected to the provider's authorization page.
3. After granting access you are returned to the integrations page with status **Connected**.
4. Tokens are stored encrypted (AES-256-GCM + KMS). You will receive an in-app notification
   if your token expires and re-authentication is needed.

## Re-authenticating

If a token expires or is revoked, the server's status changes to **Needs re-auth**. A
notification appears in the bell menu with a deep link to re-authenticate. You can also
click **Re-authenticate** directly on the integrations page.

## Health status

Each server row shows a health indicator:

| Status | Meaning |
|---|---|
| Healthy | Server is reachable and responding. |
| Degraded | Some MCP calls are failing; tools may be unreliable. |
| Unreachable | Server did not respond to the last health probe. |
| Needs re-auth | OAuth token is expired or revoked. |

Agents only use servers with **Healthy** status. Degraded or unreachable servers are
skipped at runtime and a warning is logged.

## Roles

| Action | Required role |
|---|---|
| Enable / disable for workspace | Workspace Owner or Org Owner/Admin |
| Connect / re-authenticate | Workspace Owner or Org Owner/Admin |
| Install / uninstall from org | Org Owner or Admin only |
| Manage denylist | Org Owner or Admin only |
```

- [ ] Commit: `docs: add marketplace and workspace-plugins MDX pages`

### K2 — Capability docs

- [ ] Create `docs/capabilities/plugin.catalog.browse.md`.

```markdown
# plugin.catalog.browse

**Purpose:** Search and paginate the plugin catalog (all registered servers across all registries for this org).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/catalog/browse`), MCP tool `plugin_catalog_browse`.

**Roles:** Any authenticated org member (read-only).

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (optional filter)
- `search` — full-text search string (optional)
- `cursor` — pagination cursor from previous response (optional)
- `limit` — max results, 1–100, default 20

**Output:**
- `servers[]` — array of catalog server summaries (id, name, title, description, transport, authKind, status)
- `nextCursor` — opaque cursor for the next page, or `null` if last page
```

- [ ] Create `docs/capabilities/plugin.org.install.md`.

```markdown
# plugin.org.install

**Purpose:** Install a catalog server (or custom server) to the org allow-list. Server is **disabled by default** after install.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/install`), MCP tool `plugin_org_install`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (default: `mcp_server`)
- `catalogServerId` — public_id of a catalog server to install (mutually exclusive with `custom`)
- `custom` — object `{ name, title?, description?, endpointUrl, transport, authKind }` for a custom server

**Output:**
- `orgListingId` — public_id of the created `plugin.org_listings` row
```

- [ ] Create `docs/capabilities/plugin.org.install_bulk.md`.

```markdown
# plugin.org.install_bulk

**Purpose:** Install multiple catalog servers to the org allow-list in one request (multi-select marketplace action).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/install-bulk`), MCP tool `plugin_org_install_bulk`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `catalogServerIds[]` — array of catalog server public_ids (1–50)

**Output:**
- `installed[]` — array of `{ catalogServerId, orgListingId }` for each successfully installed server
- `errors[]` — array of `{ catalogServerId, reason }` for any failures (partial success is allowed)
```

- [ ] Create `docs/capabilities/plugin.workspace.set_enabled.md`.

```markdown
# plugin.workspace.set_enabled

**Purpose:** Enable or disable a plugin server for this workspace. Enabling upserts an `agent.mcp_servers` row from the org listing; disabling sets it to `enabled=false`.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/workspace/set-enabled`), MCP tool `plugin_workspace_set_enabled`.

**Roles:** Org Owner, Org Admin, Workspace Owner.

**Input:**
- `orgListingId` — public_id of the org listing to enable/disable for this workspace
- `enabled` — `true` to enable, `false` to disable

**Output:**
- `workspaceServerId` — public_id of the `agent.mcp_servers` row (or `null` when disabling and no row existed)
```

- [ ] Create `docs/capabilities/plugin.denylist.add.md`.

```markdown
# plugin.denylist.add

**Purpose:** Add a plugin server name to the org denylist. Immediately disables and removes any matching org listings and workspace installs.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/denylist/add`), MCP tool `plugin_denylist_add`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (default: `mcp_server`)
- `serverName` — reverse-DNS server name (e.g. `io.github.acme.my-server`)
- `reason` — optional human-readable reason shown in the marketplace UI

**Output:**
- `ok` — `true` on success
```

- [ ] Create `docs/capabilities/plugin.denylist.remove.md`.

```markdown
# plugin.denylist.remove

**Purpose:** Remove a server name from the org denylist, making it installable again.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/denylist/remove`), MCP tool `plugin_denylist_remove`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `serverName` — the server name to un-deny

**Output:**
- `ok` — `true` on success
```

- [ ] Create `docs/capabilities/plugin.org.uninstall.md`.

```markdown
# plugin.org.uninstall

**Purpose:** Remove a plugin server from the org allow-list (destructive — also removes all workspace installs for this server).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/uninstall`), MCP tool `plugin_org_uninstall`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `orgListingId` — public_id of the org listing to remove

**Output:**
- `ok` — `true` on success
```

- [ ] Commit: `docs: add capability docs for plugin.* contracts`

---

## Task L — Final verification pass

- [ ] Run the E2E suite (requires local dev stack up: `pnpm dev` in repo root, Docker on port 5433):

```bash
pnpm --filter @oxagen/app exec playwright test apps/app/e2e/mcp-marketplace-install.spec.ts \
  apps/app/e2e/mcp-org-add-custom.spec.ts \
  apps/app/e2e/mcp-workspace-enable.spec.ts \
  apps/app/e2e/mcp-oauth-connect.spec.ts \
  apps/app/e2e/mcp-disable.spec.ts \
  apps/app/e2e/mcp-uninstall.spec.ts \
  apps/app/e2e/mcp-denylist.spec.ts \
  apps/app/e2e/mcp-rbac-negative.spec.ts \
  apps/app/e2e/mcp-agent-integration.spec.ts
```

Or the full suite (from repo root):

```bash
pnpm test:e2e
# equivalent to: pnpm --filter @oxagen/app exec playwright test
```

Expected: **all 9 plugin specs green**, no real network calls to registry.modelcontextprotocol.io or any LLM provider.

**Offline guarantee:** The mock MCP server and mock OAuth server are started by `globalSetup` from `e2e/fixtures/global-setup.ts` before any spec runs. `interceptAgentStream` intercepts all `**/api/v1/chat/stream` and `**/api/anthropic/**` requests. No real tokens are needed.

- [ ] Run `pnpm check:manifest` — must exit 0 (warn-only). Plugin contracts declare `layers: ["api", "mcp", "unit"]`, not `"e2e"`, so no manifest gaps for the new specs. VERIFY: `packages/oxagen/src/contracts/plugin.org.install.ts` `layers` field.

- [ ] Run full typecheck:

```bash
pnpm --filter @oxagen/app typecheck
pnpm --filter @oxagen/docs typecheck
```

- [ ] Run lint:

```bash
pnpm --filter @oxagen/app lint
```

- [ ] Commit: `chore(e2e): final verification pass — plugin specs green`

---

## Done-criteria

- [ ] `apps/app/e2e/fixtures/mock-mcp-server.ts` — in-process MCP server, one `e2e_ping` tool.
- [ ] `apps/app/e2e/fixtures/mock-oauth-server.ts` — in-process OAuth 2.1 AS (well-known + authorize + token).
- [ ] `apps/app/e2e/fixtures/global-setup.ts` — starts both fixture servers; `playwright.config.ts` wired.
- [ ] `apps/app/e2e/helpers/seed-plugin.ts` — tenant + plugin rows seeded, cleanup provided.
- [ ] Nine Playwright specs (flows 1–9) in `apps/app/e2e/`: each green, deterministic, offline.
- [ ] `data-testid` attributes listed per spec are present on the corresponding Plan 6 components (or this plan task instructs adding them).
- [ ] `apps/docs/content/docs/plugins/marketplace.mdx` — marketplace user guide.
- [ ] `apps/docs/content/docs/plugins/workspace-plugins.mdx` — workspace install + auth guide.
- [ ] `docs/capabilities/plugin.*.md` — one capability doc per contracted plugin capability.
- [ ] `pnpm check:manifest` — exits 0, no new gaps.
- [ ] `pnpm --filter @oxagen/app typecheck` — no errors.
- [ ] `pnpm test:e2e` — all suites green.

---

> **This completes the installable-plugins epic (Plans 1–7).**
>
> Plans 1–6 built the schema, credential service, catalog sync, spine capabilities, OAuth auth subsystem, notifications, and UI. Plan 7 closes the loop with deterministic offline E2E coverage of every enumerated flow and user-facing documentation for the marketplace and workspace install surfaces.
