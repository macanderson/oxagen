/**
 * mcp-oauth-mock-provider.spec.ts
 *
 * The DETERMINISTIC, CI-repeatable half of the MCP-server auth strategy: it
 * proves the FULL install → authenticate → connected loop for an OAuth MCP
 * server end to end, WITHOUT any real third party, plus the secret and no-auth
 * paths.
 *
 * A tiny in-process Node HTTP server (bound to 127.0.0.1 on an ephemeral port)
 * plays BOTH roles the flow needs:
 *   - the MCP resource server (RFC 9728 /.well-known/oauth-protected-resource,
 *     pointing its own origin at itself as the authorization server), and
 *   - its own OAuth 2.1 Authorization Server (RFC 8414 metadata, RFC 7591
 *     dynamic client registration, an auto-approving /authorize consent page,
 *     and a /token endpoint).
 *
 * The app's OAuth authorize/callback routes drive the real MCP SDK `auth()`
 * against this mock: discovery → DCR → PKCE → browser redirect to the mock
 * consent page → code exchange at /token → encrypted-token storage → the
 * installed row flips to "Connected". `safe-fetch.ts` has NO localhost/SSRF
 * blocking, so the app server (on :3000 / :3100) reaches the mock on 127.0.0.1.
 *
 * Tests (run serial so the shared mock server + screenshot dir are set up once):
 *   1. OAuth happy path — connect form → authenticate dialog → mock consent →
 *      code exchange → installed row shows "Connected" (and the mock recorded a
 *      /register + /token hit).
 *   2. Secret path — connect a "Secret / API key" server → post-install secret
 *      dialog → store a key → row flips to "Connected".
 *   3. No-auth path — connect a "No authentication" server → row shows
 *      "No auth needed" and the server is immediately enabled.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs. When the app runs on a non-default
 * port, point Playwright at it via PLAYWRIGHT_BASE_URL (e.g.
 * PLAYWRIGHT_BASE_URL=http://localhost:3100). The mock provider binds an
 * ephemeral 127.0.0.1 port regardless.
 */

import { test, expect } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "mcp-oauth-mock-provider",
);

// ── Mock provider ───────────────────────────────────────────────────────────

interface MockServer {
  /** e.g. http://127.0.0.1:54123 — origin the app discovers + the browser hits. */
  baseUrl: string;
  /** The MCP endpoint URL to paste into the connect form. */
  mcpUrl: string;
  /** "METHOD /path" for every request received — deterministic proof + debug. */
  hits: string[];
  close: () => Promise<void>;
}

/** Structured stdout log (console.* is disallowed; process.stdout is not). */
function log(label: string, msg: string): void {
  process.stdout.write(`[mock:${label}] ${msg}\n`);
}

/** Minimal HTML-attribute escaping for the consent page's Approve href. */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Start a mock server on an ephemeral 127.0.0.1 port.
 *
 * `enableOauth: true` makes it a full OAuth AS + protected resource. With
 * `enableOauth: false` it is a plain, reachable, no-auth MCP endpoint: the
 * well-known probes 404 and an unauthenticated initialize answers 200 (never
 * 401), so the install-time OAuth detection (packages/plugins detect-oauth.ts,
 * which runs only for authKind "none") leaves it as "none" instead of upgrading
 * it to "oauth". A single OAuth origin cannot double as the no-auth origin
 * because RFC 9728 discovery is origin-level, so the two paths use two servers.
 */
async function startMockServer(opts: {
  enableOauth: boolean;
  label: string;
}): Promise<MockServer> {
  const hits: string[] = [];

  const respondJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = (
    req: IncomingMessage,
    res: ServerResponse,
    bodyRaw: string,
  ): void => {
    const method = req.method ?? "GET";
    const host = req.headers.host ?? "127.0.0.1";
    const base = `http://${host}`;
    const u = new URL(req.url ?? "/", base);
    const pathname = u.pathname;
    hits.push(`${method} ${pathname}`);
    log(opts.label, `${method} ${pathname}`);

    // ── RFC 9728: protected-resource metadata (points AS at this same origin) ─
    if (
      opts.enableOauth &&
      pathname.startsWith("/.well-known/oauth-protected-resource")
    ) {
      respondJson(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
      });
      return;
    }

    // ── RFC 8414: authorization-server metadata (also at openid-configuration) ─
    if (
      opts.enableOauth &&
      (pathname.startsWith("/.well-known/oauth-authorization-server") ||
        pathname.startsWith("/.well-known/openid-configuration"))
    ) {
      respondJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      });
      return;
    }

    // ── RFC 7591: dynamic client registration ────────────────────────────────
    if (opts.enableOauth && pathname === "/register" && method === "POST") {
      let redirectUris: string[] = [];
      try {
        const parsed: unknown = JSON.parse(bodyRaw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { redirect_uris?: unknown }).redirect_uris)
        ) {
          redirectUris = (
            parsed as { redirect_uris: unknown[] }
          ).redirect_uris.filter((x): x is string => typeof x === "string");
        }
      } catch {
        // Best-effort echo; a missing body still yields a valid registration.
      }
      respondJson(res, 201, {
        client_id: "mock-client",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret: "mock-client-secret",
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
      return;
    }

    // ── Authorization endpoint: deterministic auto-approve consent page ───────
    // Renders a tiny consent screen (great screenshot, no login UI) whose
    // "Approve" link redirects the browser straight to the app's callback with
    // a fixed code + the echoed state. This is the stand-in for the third
    // party's consent screen.
    if (opts.enableOauth && pathname === "/authorize") {
      const redirectUri = u.searchParams.get("redirect_uri");
      const state = u.searchParams.get("state") ?? "";
      if (!redirectUri) {
        respondJson(res, 400, { error: "missing redirect_uri" });
        return;
      }
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", "mock-auth-code");
      if (state) dest.searchParams.set("state", state);
      const href = htmlEscape(dest.toString());
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock OAuth Provider</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f19;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:420px;padding:32px;background:#111827;border:1px solid #1f2937;border-radius:16px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#9ca3af;margin:0 0 24px}a.btn{display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600}</style></head><body><main><h1>Mock OAuth Provider</h1><p>Authorize <strong>Oxagen</strong> to access this MCP server on your behalf.</p><a class="btn" id="mock-oauth-approve" data-testid="mock-oauth-approve" href="${href}">Approve</a></main></body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── Token endpoint: accepts both code exchange and refresh_token grant ────
    if (opts.enableOauth && pathname === "/token" && method === "POST") {
      respondJson(res, 200, {
        access_token: "mock-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "mock-refresh-token",
        scope: "mcp",
      });
      return;
    }

    // ── MCP endpoint: 200 for the redirect-resolve GET + the no-auth probe ────
    // Deliberately never 401, so the no-auth install probe keeps authKind
    // "none" for the plain server.
    if (pathname === "/mcp") {
      respondJson(res, 200, { ok: true, server: opts.label });
      return;
    }

    respondJson(res, 404, { error: "not found" });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        log(opts.label, `handler error: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "mock server error" }));
      }
    });
    req.on("error", () => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Serial so the shared mock servers + the delete-and-recreate of the screenshot
// directory happen exactly once (a parallel split would race the rm/mkdir).
test.describe.configure({ mode: "serial" });

let oauthMock: MockServer;
let plainMock: MockServer;

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  oauthMock = await startMockServer({ enableOauth: true, label: "oauth" });
  plainMock = await startMockServer({ enableOauth: false, label: "plain" });
  process.stdout.write(
    `[mock] oauth=${oauthMock.baseUrl} plain=${plainMock.baseUrl}\n`,
  );
});

test.afterAll(async () => {
  await oauthMock?.close();
  await plainMock?.close();
});

// A status badge (server-generated id) whose text matches, matched by testid
// prefix + text since row ids are not known ahead of time.
function statusBadge(page: Page, text: string): Locator {
  return page
    .locator('[data-testid^="mcp-server-status-"]')
    .filter({ hasText: text });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe("MCP OAuth — deterministic mock provider", () => {
  test("OAuth happy path: install → authenticate → mock consent → Connected", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-oauth" });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/workbench/tools/mcp`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("connect-mcp-form")).toBeVisible({
      timeout: 20_000,
    });

    // ── Fill + submit the connect form (OAuth) ───────────────────────────────
    await page.getByTestId("mcp-server-name-input").fill("Mock OAuth Server");
    await page
      .getByTestId("mcp-server-endpoint-input")
      .fill(oauthMock.mcpUrl);
    await page.getByText("OAuth", { exact: true }).click();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-oauth-connect-form-filled.png"),
      fullPage: true,
    });
    await page.getByTestId("connect-mcp-submit-btn").click();

    // ── Post-install authenticate dialog ─────────────────────────────────────
    const dialog = page.getByTestId("mcp-authenticate-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(
      dialog.getByRole("button", {
        name: "Authenticate with Mock OAuth Server",
      }),
    ).toBeEnabled();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-oauth-authenticate-dialog.png"),
      fullPage: true,
    });

    // Clicking navigates the whole window into the authorize route, which does
    // discovery + DCR + PKCE against the mock and redirects to its consent page.
    await dialog.getByTestId("mcp-authenticate-now").click();

    // ── Mock provider consent page → Approve ─────────────────────────────────
    const approve = page.getByTestId("mock-oauth-approve");
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-oauth-mock-consent.png"),
      fullPage: true,
    });
    await approve.click();

    // ── Back on the MCP page — the callback exchanged the code + stored tokens ─
    await page.waitForURL(/\/workbench\/tools\/mcp/, { timeout: 60_000 });
    await expect(statusBadge(page, "Connected").first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-oauth-connected-row.png"),
      fullPage: true,
    });

    // Deterministic proof the full OAuth round-trip actually ran against the
    // mock: DCR + token exchange both hit it.
    expect(
      oauthMock.hits.some((h) => h === "POST /register"),
      `mock hits: ${oauthMock.hits.join(", ")}`,
    ).toBeTruthy();
    expect(
      oauthMock.hits.some((h) => h === "POST /token"),
      `mock hits: ${oauthMock.hits.join(", ")}`,
    ).toBeTruthy();
  });

  test("Secret path: install → secret dialog → stored key → Connected", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mcp-secret",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/workbench/tools/mcp`);
    await expect(page.getByTestId("connect-mcp-form")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("mcp-server-name-input").fill("Mock Secret Server");
    await page.getByTestId("mcp-server-endpoint-input").fill(plainMock.mcpUrl);
    await page.getByText("Secret / API key", { exact: true }).click();
    await page.getByTestId("connect-mcp-submit-btn").click();

    // ── Post-install secret-entry dialog ─────────────────────────────────────
    const secretDialog = page.getByTestId("mcp-secret-dialog");
    await expect(secretDialog).toBeVisible({ timeout: 30_000 });
    await secretDialog
      .getByTestId("mcp-secret-input")
      .fill("sk_test_mock_secret_key");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-secret-dialog.png"),
      fullPage: true,
    });
    await secretDialog.getByTestId("mcp-secret-save").click();
    await expect(secretDialog).toBeHidden({ timeout: 15_000 });

    // Storing the key flips the row to Connected (after the form's refresh).
    await expect(statusBadge(page, "Connected").first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-secret-connected-row.png"),
      fullPage: true,
    });
  });

  test("No-auth path: install → No auth needed, immediately enabled", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-none" });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/workbench/tools/mcp`);
    await expect(page.getByTestId("connect-mcp-form")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("mcp-server-name-input").fill("Mock No-Auth Server");
    await page.getByTestId("mcp-server-endpoint-input").fill(plainMock.mcpUrl);
    await page.getByText("No authentication", { exact: true }).click();
    await page.getByTestId("connect-mcp-submit-btn").click();

    // No dialog for a no-auth server — it's installed and usable immediately.
    await expect(statusBadge(page, "No auth needed").first()).toBeVisible({
      timeout: 30_000,
    });

    const row = page
      .locator('[data-testid^="mcp-server-row-"]')
      .filter({ hasText: "Mock No-Auth Server" });
    await expect(row.first()).toBeVisible();
    // Immediately enabled: the row's toggle is on.
    await expect(
      row.first().locator('[data-testid^="mcp-server-toggle-"]'),
    ).toBeChecked();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "07-none-installed-row.png"),
      fullPage: true,
    });
  });
});
