/**
 * mcp-api-parity.spec.ts — verify that the same capability is reachable
 * identically from both the API and via the Next.js app route.
 *
 * Focused parity assertion: agent.tool.list
 *   - API path:  POST http://localhost:4000/v1/:orgSlug/:workspaceSlug/agent/tools
 *   - App path:  GET  /<orgSlug>/<workspaceSlug>/tools  (rendered page)
 *
 * Both must respond with an authorized result (not 401, not /login redirect)
 * when called with the signed-up user's session.
 *
 * The test signs up a fresh user so it is independent and safe under
 * fullyParallel.
 *
 * API AVAILABILITY: a beforeAll guard asserts the API server is reachable.
 * If the API is down the suite fails loudly — it does NOT silently skip,
 * because silent skips hide parity regressions. Run the API server before
 * executing these tests (pnpm --filter @oxagen/api dev or the turbo dev task).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

/** Extract the raw `oxagen.session_token` cookie value from the page context. */
async function getSessionCookieValue(
  page: import("@playwright/test").Page,
  baseUrl: string,
): Promise<string | null> {
  const url = new URL(baseUrl);
  const cookies = await page.context().cookies(baseUrl);
  const sessionCookie = cookies.find(
    (c) => c.name === "oxagen.session_token" && c.domain === url.hostname,
  );
  return sessionCookie?.value ?? null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Assert the API server is reachable. Called in beforeAll for every suite
 * that sends requests to the external API. Fails with a clear message rather
 * than silently skipping so parity regressions are never hidden.
 */
async function assertApiIsUp(request: import("@playwright/test").APIRequestContext): Promise<void> {
  let reachable = false;
  try {
    const probe = await request.get(`${API_BASE}/health`, { timeout: 5_000 });
    // Accept any non-5xx response — the route may not exist, but that proves
    // the server is listening.
    reachable = probe.status() < 500;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    throw new Error(
      `API server at ${API_BASE} is not reachable. ` +
        "Start it with `pnpm --filter @oxagen/api dev` before running parity tests.",
    );
  }
}

test.describe("MCP-API parity: agent.tool.list", () => {
  test.beforeAll(async ({ request }) => {
    await assertApiIsUp(request);
  });

  test("agent.tool.list via API route returns authorized response", async ({
    page,
    baseURL,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "parity" });

    // After signup the page context has the session cookie set by Better Auth.
    // Extract it so we can send it to the external API.
    const rawCookieValue = await getSessionCookieValue(
      page,
      baseURL ?? "http://localhost:3000",
    );

    expect(rawCookieValue).not.toBeNull();

    // The workspace was created as "default" by createOrgAction.
    const workspaceSlug = "default";
    const apiUrl = `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/agent/tools`;

    // POST to the API with the session cookie.
    const response = await page.request.post(apiUrl, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `oxagen.session_token=${rawCookieValue ?? ""}`,
      },
      data: {},
    });

    // Must not be 401 (unauthorized) — the session cookie is valid.
    // A 200 or 404 (no tools seeded yet) are both acceptable "authorized" responses.
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(403);

    // The response should be JSON (not an HTML login page).
    const contentType = response.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");
  });

  test("agent.tool.list via app tools page returns authorized response", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "parity-ui" });
    const workspaceSlug = "default";

    // Navigate to the tools page.
    await page.goto(`/${orgSlug}/${workspaceSlug}/tools`);

    // Must not redirect to /login.
    await expect(page).not.toHaveURL(/\/login/);

    // The URL must still contain both slugs — we're in the authenticated shell.
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/${workspaceSlug}`));
  });
});

test.describe("MCP-API parity: org.member.add endpoint is auth-gated", () => {
  test.beforeAll(async ({ request }) => {
    await assertApiIsUp(request);
  });

  test("org.member.add via API requires auth — 401 without credentials", async ({
    page,
  }) => {
    // Use a known-fake org/workspace slug — we only care that 401 is returned.
    const apiUrl = `${API_BASE}/v1/fake-org/fake-ws/org/members`;

    const response = await page.request.post(apiUrl, {
      headers: { "Content-Type": "application/json" },
      data: { email: "test@example.com", role: "member" },
    });

    // Without credentials the API must return 401.
    expect(response.status()).toBe(401);
  });

  test("org.member.add via API with valid session is authorized (not 401)", async ({
    page,
    baseURL,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "parity-member" });
    const workspaceSlug = "default";
    const rawCookieValue = await getSessionCookieValue(
      page,
      baseURL ?? "http://localhost:3000",
    );

    expect(rawCookieValue).not.toBeNull();

    const apiUrl = `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/org/members`;

    const response = await page.request.post(apiUrl, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `oxagen.session_token=${rawCookieValue ?? ""}`,
      },
      // Intentionally invalid body to get a validation error (not a 401).
      data: { email: "invalid-not-a-real-email" },
    });

    // Any response that is NOT 401/403 proves the session was accepted.
    // 400 (validation error), 201 (success), 422 — all mean auth passed.
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(403);
  });
});
