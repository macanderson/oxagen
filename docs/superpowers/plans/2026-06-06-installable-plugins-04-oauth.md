# Installable Plugins — Plan 4: MCP OAuth 2.1 (discovery / DCR / PKCE / refresh / re-auth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org admin connect an OAuth-protected MCP server through the standard MCP OAuth 2.1 flow (authorization-server discovery, dynamic client registration, authorization-code + PKCE, token exchange), store tokens encrypted, refresh them silently, and flip a credential to `needs_reauth` when refresh fails (the trigger Plan 5 notifies on).

**Architecture:** Use the **MCP SDK's built-in OAuth** (`@modelcontextprotocol/sdk@1.29.0`) — do NOT hand-roll RFC 8414/7591/PKCE. Implement one `OAuthClientProvider` (`DbOAuthClientProvider`) backed by `mcp.credentials` (tokens + DCR client info) and `auth.verifications` (ephemeral PKCE verifier + state). Two browser-facing Next route handlers in `apps/app` drive authorize-redirect + callback. `connectMcp` gains an optional `authProvider` so the runtime transport auto-refreshes; refresh failure marks `needs_reauth`.

**Tech Stack:** `@modelcontextprotocol/sdk@1.29.0` (client/auth), `@oxagen/crypto` envelope, Drizzle, Zod, Vitest, Next route handlers.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§6 auth subsystem)

**Builds on Plans 1–3 (shipped):** `mcp.credentials` (access/refresh/oauthClientSecret enc + oauthClientId + scopes + expiresAt + status), `setWorkspaceSecret`/`getWorkspaceSecret`, the `agent.mcp_servers` workspace install row, and the MCP contributor in `materializeTools`.

---

## Grounded conventions (verified)

- **MCP SDK OAuth** (`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.d.ts`): `OAuthClientProvider` interface (`redirectUrl`, `clientMetadata`, `state?()`, `clientInformation()`, `saveClientInformation?()`, `tokens()`, `saveTokens()`, `redirectToAuthorization()`, `saveCodeVerifier()`, `codeVerifier()`, …); `auth(provider, { serverUrl, authorizationCode?, scope? })` → `"AUTHORIZED" | "REDIRECT"` orchestrates discovery→DCR→PKCE→exchange; `refreshAuthorization(...)`; `OAuthTokens`/`OAuthClientInformationFull` types.
- **`StreamableHTTPClientTransport`** accepts `{ authProvider?: OAuthClientProvider, requestInit?: { headers } }` and exposes `transport.finishAuth(code)`. `connectMcp` (`packages/agent/src/dispatch/mcp-client.ts:25`) currently passes only `requestInit.headers`.
- **PKCE/state store:** reuse `auth.verifications` (`schema.verifications`: `id`, `identifier`, `value`, `expiresAt`, timestamps). Key by `state`, store JSON `{ codeVerifier, orgId, workspaceId, orgListingId }`, 10-min TTL.
- **OAuth routes belong in `apps/app`** (browser-facing, session cookie). Mirror `apps/app/src/app/api/v1/stripe/checkout/route.ts` for session/org resolution (`getSession`, `resolveOrg`, `assertOrgMember`). All `/api/**` paths bypass `proxy.ts`.
- Tokens persist via `mcp.credentials` (encrypted by `@oxagen/crypto`); reuse the Plan 1 `credential-service` + `resolveCredentialKms`.

---

## File Structure

- Modify: `packages/agent/src/dispatch/mcp-client.ts` — `McpConnectArgs.authProvider?` + pass to transport
- Create: `packages/plugins/src/oauth/db-oauth-provider.ts` (+ `.test.ts`) — `DbOAuthClientProvider`
- Create: `packages/plugins/src/oauth/state-store.ts` (+ `.test.ts`) — PKCE/state via `auth.verifications`
- Create: `packages/plugins/src/oauth/index.ts` — barrel; re-export from `packages/plugins/src/index.ts`
- Create: `apps/app/src/app/api/v1/mcp/oauth/authorize/route.ts` — GET authorize-redirect
- Create: `apps/app/src/app/api/v1/mcp/oauth/callback/route.ts` — GET callback → token exchange
- Modify: `packages/agent/src/runtime/plugin-types/mcp.ts` — use `DbOAuthClientProvider` for `oauth` listings (auto-refresh) instead of static bearer
- Create: `packages/plugins/src/oauth/mark-reauth.ts` — `markCredentialNeedsReauth(...)`
- Create: `packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts` — proactive refresh/needs_reauth sweep; register in `functions.ts` + add `plugin/oauth.refresh.check` cron (no event payload)
- Create: contract+handler+route+tool+test for `plugin.credential.reauth` (returns the authorize URL to start re-auth)

---

## Task 1: `connectMcp` accepts an `authProvider`

**Files:** Modify `packages/agent/src/dispatch/mcp-client.ts`.

- [ ] **Step 1:** Extend `McpConnectArgs`:
```ts
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
export interface McpConnectArgs {
  endpointUrl: string;
  authStrategy: "none" | "bearer" | "header";
  authConfig?: Record<string, string>;
  authProvider?: OAuthClientProvider; // OAuth path — transport auto-refreshes
}
```
- [ ] **Step 2:** Pass it to the transport:
```ts
const transport = new StreamableHTTPClientTransport(new URL(args.endpointUrl), {
  authProvider: args.authProvider,
  requestInit: { headers: buildHeaders(args) },
});
```
(When `authProvider` is undefined the behavior is unchanged.)
- [ ] **Step 3:** Typecheck `@oxagen/agent`; commit `feat(agent): connectMcp accepts an OAuth authProvider`.

---

## Task 2: PKCE/state store (`auth.verifications`)

**Files:** Create `packages/plugins/src/oauth/state-store.ts` + `.test.ts`.

- [ ] **Step 1: Test** (mock `@oxagen/database`): `saveOAuthState(state, data, expiresAt)` writes a `verifications` row (`identifier = "mcp_oauth:" + state`, `value = JSON`); `loadOAuthState(state)` reads + JSON-parses it; `deleteOAuthState(state)` removes it; expired rows return null.

- [ ] **Step 2: Implement `state-store.ts`:**
```ts
/** Ephemeral MCP OAuth PKCE/state store, backed by auth.verifications (TTL'd). */
import { and, eq, gt } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

const PREFIX = "mcp_oauth:";
export interface OAuthStateData {
  codeVerifier: string;
  orgId: string;
  workspaceId: string;
  orgListingId: string;
}

export async function saveOAuthState(state: string, data: OAuthStateData, now: number): Promise<void> {
  const expiresAt = new Date(now + 10 * 60 * 1000);
  await withSystemDb(async (tx) => {
    await tx
      .insert(schema.verifications)
      .values({ id: PREFIX + state, identifier: PREFIX + state, value: JSON.stringify(data), expiresAt })
      .onConflictDoUpdate({ target: schema.verifications.id, set: { value: JSON.stringify(data), expiresAt } });
  });
}

export async function loadOAuthState(state: string, now: number): Promise<OAuthStateData | null> {
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select({ value: schema.verifications.value })
      .from(schema.verifications)
      .where(and(eq(schema.verifications.id, PREFIX + state), gt(schema.verifications.expiresAt, new Date(now))))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  return JSON.parse(row.value) as OAuthStateData;
}

export async function deleteOAuthState(state: string): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx.delete(schema.verifications).where(eq(schema.verifications.id, PREFIX + state));
  });
}
```
VERIFY the `verifications` table column names + that `id`/`identifier` are `text` (read `packages/database/src/schema/auth.ts`); adjust if `id` is auto-generated (then key on `identifier` only and let `id` default).

- [ ] **Step 3:** Test green; commit `feat(plugins): MCP OAuth PKCE/state store`.

---

## Task 3: `DbOAuthClientProvider`

**Files:** Create `packages/plugins/src/oauth/db-oauth-provider.ts` + `.test.ts`.

Implements `OAuthClientProvider` against `mcp.credentials` (tokens + DCR client info) and the state store (code verifier). The provider is constructed per (orgId, workspaceId, orgListingId, redirectUrl) + a `state` string. `redirectToAuthorization(url)` stores the URL on the instance (`this.pendingRedirect`) so the authorize route can read it.

- [ ] **Step 1: Test** — with `@oxagen/database` + state-store mocked: `saveTokens`/`tokens` round-trip through `mcp.credentials` (encrypted, no plaintext at rest); `saveClientInformation`/`clientInformation` round-trip `oauthClientId` + encrypted secret; `saveCodeVerifier`/`codeVerifier` go through the state store; `redirectToAuthorization(url)` sets `pendingRedirect`.

- [ ] **Step 2: Implement** (uses `setWorkspaceSecret`/`getWorkspaceSecret` for tokens, direct `mcp.credentials` update for client info, state-store for verifier):
```ts
import type {
  OAuthClientProvider, OAuthClientInformation, OAuthClientInformationFull,
  OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { setWorkspaceSecret, getWorkspaceSecret } from "../credentials/workspace-credential";
import { saveOAuthState, loadOAuthState } from "./state-store";

export interface DbProviderCtx {
  orgId: string; workspaceId: string; orgListingId: string;
  redirectUrl: string; state: string; clientName: string; now: () => number;
}

export class DbOAuthClientProvider implements OAuthClientProvider {
  pendingRedirect: URL | null = null;
  private clientInfo: OAuthClientInformationFull | null = null;
  constructor(private readonly c: DbProviderCtx) {}

  get redirectUrl(): string { return this.c.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.c.clientName,
      redirect_uris: [this.c.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  state(): string { return this.c.state; }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.clientInfo) return this.clientInfo;
    const cred = await getWorkspaceSecret({ orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId });
    // oauthClientId lives on the credential row; secret in oauthClientSecret (decrypted)
    return undefined; // VERIFY: load oauthClientId from the row; getWorkspaceSecret currently returns secrets only — extend it to also return oauthClientId, or read the row directly here.
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = info;
    await setWorkspaceSecret({
      orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId,
      authKind: "oauth", oauthClientId: info.client_id, oauthClientSecret: info.client_secret ?? null,
    });
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await getWorkspaceSecret({ orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId });
    if (!cred?.accessToken) return undefined;
    return {
      access_token: cred.accessToken,
      token_type: "Bearer",
      refresh_token: cred.refreshToken ?? undefined,
    };
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setWorkspaceSecret({
      orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId,
      authKind: "oauth", accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null,
    });
  }
  async redirectToAuthorization(url: URL): Promise<void> { this.pendingRedirect = url; }
  async saveCodeVerifier(verifier: string): Promise<void> {
    await saveOAuthState(this.c.state, { codeVerifier: verifier, orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId }, this.c.now());
  }
  async codeVerifier(): Promise<string> {
    const s = await loadOAuthState(this.c.state, this.c.now());
    if (!s) throw new Error("[mcp-oauth] code verifier expired or missing");
    return s.codeVerifier;
  }
}
```
> VERIFY items: (a) extend `getWorkspaceSecret` (and the `WorkspaceSecret` type) to also return `oauthClientId` so `clientInformation()` can return `{ client_id, client_secret }`; (b) confirm the `OAuthClientInformation`/`OAuthTokens`/`OAuthClientMetadata` field names against the SDK's `auth.d.ts` and adjust; (c) `client_secret` decryption — `getWorkspaceSecret` returns `oauthClientSecret` already.

- [ ] **Step 3:** Implement the `getWorkspaceSecret` extension (return `oauthClientId` from the row). Test green. Barrel-export the provider + state store from `packages/plugins/src/oauth/index.ts` and `src/index.ts`. Commit `feat(plugins): DbOAuthClientProvider over mcp.credentials`.

> Before Task 4: extend `OAuthStateData` (Task 2) and `DbProviderCtx` (Task 3) with `returnTo: string`, and have `saveCodeVerifier` persist it, so the callback can redirect the browser back to the originating workspace settings page.

---

## Task 4: Authorize + callback route handlers (`apps/app`)

**Files:** Create `apps/app/src/app/api/v1/mcp/oauth/authorize/route.ts` and `.../callback/route.ts`. Mirror `apps/app/src/app/api/v1/stripe/checkout/route.ts` for `getSession`/`resolveOrg`/`assertOrgMember` imports.

- [ ] **Step 1: authorize route** — GET `?orgSlug&workspaceSlug&orgListingId`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider } from "@oxagen/plugins";
import { getSession } from "@/lib/session";
import { resolveOrg, assertMcpManager } from "@/lib/resolve-org"; // assertMcpManager added in Plan 6; until then use assertOrgMember
import { runInTenantScope } from "@oxagen/tenancy";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const orgSlug = url.searchParams.get("orgSlug");
  const workspaceSlug = url.searchParams.get("workspaceSlug");
  const orgListingId = url.searchParams.get("orgListingId");
  if (!orgSlug || !workspaceSlug || !orgListingId) {
    return NextResponse.json({ error: "missing params" }, { status: 400 });
  }
  const tenant = await resolveOrg(orgSlug);
  await assertMcpManager(tenant.id, session.user.id); // owner/admin only

  // Resolve the listing + workspace id.
  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx.select().from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, orgListingId)).limit(1);
    return l ?? null;
  });
  if (!listing || listing.orgId !== tenant.id || !listing.endpointUrl) {
    return NextResponse.json({ error: "listing not connectable" }, { status: 404 });
  }
  const workspaceId = await resolveWorkspaceId(tenant.id, workspaceSlug); // VERIFY a helper exists or inline a query

  const state = randomUUID();
  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;
  const returnTo = `/${orgSlug}/${workspaceSlug}/settings/integrations`;
  const provider = new DbOAuthClientProvider({
    orgId: tenant.id, workspaceId, orgListingId, redirectUrl, state, returnTo,
    clientName: "Oxagen", now: () => Date.now(),
  });

  const result = await mcpAuth(provider, { serverUrl: listing.endpointUrl });
  if (result === "AUTHORIZED") return NextResponse.redirect(`${url.origin}${returnTo}?mcp=already-connected`);
  if (!provider.pendingRedirect) return NextResponse.json({ error: "no authorization url" }, { status: 502 });
  return NextResponse.redirect(provider.pendingRedirect.toString());
}
```
VERIFY: `resolveWorkspaceId(orgId, slug)` — inline a `withTenantDb`/`withSystemDb` query on `schema.workspaces` if no helper exists. `assertMcpManager` lands in Plan 6; if not present yet, use `assertOrgMember` + a role check, or temporarily import the role set. Wrap DB writes in `runInTenantScope({ orgId: tenant.id, workspaceId })` if RLS requires it for the credential write inside `mcpAuth` → `saveClientInformation`.

- [ ] **Step 2: callback route** — GET `?code&state`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider, loadOAuthState, deleteOAuthState } from "@oxagen/plugins";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  const stateData = await loadOAuthState(state, Date.now());
  if (!stateData) return NextResponse.json({ error: "state expired" }, { status: 400 });

  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx.select().from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, stateData.orgListingId)).limit(1);
    return l ?? null;
  });
  if (!listing?.endpointUrl) return NextResponse.json({ error: "listing gone" }, { status: 404 });

  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;
  const provider = new DbOAuthClientProvider({
    orgId: stateData.orgId, workspaceId: stateData.workspaceId, orgListingId: stateData.orgListingId,
    redirectUrl, state, returnTo: stateData.returnTo, clientName: "Oxagen", now: () => Date.now(),
  });
  const result = await mcpAuth(provider, { serverUrl: listing.endpointUrl, authorizationCode: code });
  await deleteOAuthState(state);
  // On success the tokens are saved (status 'active'); flip the workspace install healthy.
  await withSystemDb(async (tx) => {
    await tx.update(schema.mcpServers)
      .set({ healthStatus: "healthy" })
      .where(eq(schema.mcpServers.orgListingId, stateData.orgListingId));
  });
  const ok = result === "AUTHORIZED";
  return NextResponse.redirect(`${url.origin}${stateData.returnTo}?mcp=${ok ? "connected" : "error"}`);
}
```
VERIFY `loadOAuthState`/`deleteOAuthState` are exported from `@oxagen/plugins`.

- [ ] **Step 3:** Typecheck `@oxagen/app` (or whatever apps/app's package name is). Commit `feat(app): MCP OAuth authorize + callback route handlers`.

---

## Task 5: Runtime uses the OAuth provider (auto-refresh) + needs_reauth

**Files:** Create `packages/plugins/src/oauth/mark-reauth.ts`; modify `packages/agent/src/runtime/plugin-types/mcp.ts`.

- [ ] **Step 1: `mark-reauth.ts`:**
```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
/** Flip a credential to needs_reauth (the trigger Plan 5 notifies on). */
export async function markCredentialNeedsReauth(workspaceId: string, orgListingId: string): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx.update(schema.mcpCredentials).set({ status: "needs_reauth", updatedAt: new Date() })
      .where(and(eq(schema.mcpCredentials.workspaceId, workspaceId), eq(schema.mcpCredentials.orgListingId, orgListingId)));
  });
}
```
Export from `@oxagen/plugins`.

- [ ] **Step 2:** In `plugin-types/mcp.ts`, for a server whose listing `authKind === "oauth"`, build a `DbOAuthClientProvider` (state unused at runtime — pass a stable dummy like `runtime:${orgListingId}`, `redirectUrl` from env `APP_URL` + `/api/v1/mcp/oauth/callback`) and pass it as `connectMcp({ endpointUrl, authStrategy: "none", authProvider })`. The transport auto-refreshes via `provider.tokens()`/`saveTokens()`. Wrap the per-server `connectMcp`+`materializeMcpTools` in try/catch; on an `UnauthorizedError` (or any auth failure), call `markCredentialNeedsReauth(ctx.workspaceId, server.orgListingId)` and skip that server. Keep the static bearer/secret path for `authKind !== "oauth"` (the Plan 3 code).
VERIFY: import `UnauthorizedError` from `@modelcontextprotocol/sdk/client/auth.js`; only mark-reauth on auth errors, not transient network errors.

- [ ] **Step 3:** Typecheck `@oxagen/agent` + `@oxagen/plugins`; commit `feat(agent): OAuth MCP servers connect via auto-refreshing provider; mark needs_reauth on failure`.

---

## Task 6: Proactive refresh-watcher (Inngest cron)

**Files:** Create `packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts`; register in `functions.ts`.

- [ ] **Step 1:** Cron (every 30 min) — scan `mcp.credentials` where `authKind='oauth' AND status='active' AND expiresAt < now()+10min`, and for each attempt a refresh by constructing a `DbOAuthClientProvider` + calling the SDK `auth(provider, { serverUrl })` (which refreshes if a refresh_token exists). On failure → `markCredentialNeedsReauth(...)`. Each credential in its own `step.run` (isolated). Mirror `billing.dunning-sweep` cron shape.
VERIFY: needs the listing's `endpointUrl` (join `pluginOrgListings` on `orgListingId`). Instrument counts (refreshed / needs_reauth).

- [ ] **Step 2:** Register `pluginOauthRefreshWatcher` in `functions.ts`; typecheck `@oxagen/inngest-functions`; commit `feat(inngest): OAuth token refresh watcher → needs_reauth`.

---

## Task 7: `plugin.credential.reauth` capability

**Files:** contract+test+handler+route+tool (mirror Plan 2 pattern), register.

- [ ] **Step 1:** `plugin.credential.reauth` (`scoped:true`, sensitivity medium, `surfaces:["api","mcp"]`, org Owner/Admin) — input `{ orgListingId: z.string() }` → output `{ authorizeUrl: z.string() }`. Handler returns the app authorize URL: `${APP_URL}/api/v1/mcp/oauth/authorize?orgSlug=...&workspaceSlug=...&orgListingId=...` (VERIFY how to resolve org/workspace slug from ctx ids — query `schema.organizations`/`schema.workspaces`, or accept slugs in input). This is what the re-auth notification deep-links to (Plan 5).
- [ ] **Step 2:** Register handler + route + tool; `pnpm check:manifest` clean; commit `feat(plugins): plugin.credential.reauth capability`.

---

## Task 8: Verification

- [ ] `pnpm check:manifest` clean for `plugin.*`.
- [ ] Typecheck `@oxagen/plugins @oxagen/agent @oxagen/inngest-functions @oxagen/oxagen @oxagen/handlers @oxagen/api @oxagen/mcp` + apps/app — all PASS.
- [ ] Tests: `pnpm --filter @oxagen/plugins test:unit` (state-store + provider unit tests green) + `pnpm --filter @oxagen/oxagen test:unit -- plugin`.
- [ ] Lint touched packages.
- [ ] **Smoke (Plan 7 covers full E2E with a mock OAuth server):** unit-level — assert `DbOAuthClientProvider.saveTokens`→`tokens` round-trips and `markCredentialNeedsReauth` flips status.

## Done criteria for Plan 4

- An admin can click "Connect" on an OAuth MCP server → SDK-driven discovery + DCR + PKCE authorize → callback exchanges the code → tokens stored encrypted → workspace install goes healthy.
- The runtime connects OAuth servers via an auto-refreshing provider; refresh failure flips the credential to `needs_reauth`.
- A cron proactively refreshes soon-to-expire tokens and marks `needs_reauth` when it can't.
- `plugin.credential.reauth` returns the authorize URL for the re-auth prompt.

**Next plan:** `2026-06-06-installable-plugins-05-notifications.md` — the `notifications` table feed + first `sendEmail` handler + org role setting, triggered by `needs_reauth`.

