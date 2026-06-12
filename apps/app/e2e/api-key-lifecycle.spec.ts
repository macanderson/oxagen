import { test, expect } from "@playwright/test";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";
import { loginWithSession } from "./helpers/auth";

// Verifies the API key create → one-time reveal → persistence → revoke lifecycle.
//
// Keys are managed through the Hono API server (port 4000):
//   POST   /v1/{org}/{ws}/api-keys         — create, returns rawKey once
//   DELETE /v1/{org}/{ws}/api-keys/revoke  — soft-delete by publicId
//
// The tokens UI page (/{org}/developer/tokens) is read-only and reflects
// the Postgres state — used here to assert UI visibility after each mutation.

const ORG_SLUG = "e2e-api-key-lifecycle";
const WS_SLUG = "main";
const USER_EMAIL = "e2e+api-key@oxagen.ai";

let fixture: AgentRuntimeFixture;

test.describe("api.key — full lifecycle", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: ORG_SLUG,
      workspaceSlug: WS_SLUG,
      userEmail: USER_EMAIL,
      // api.key.create/revoke are defaultEffect:"deny" on the IAM-enforced
      // :4000 surface — the seeded user needs principal + role_grants rows.
      bootstrapIam: true,
    });
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("create: API returns rawKey once and key appears on tokens UI page", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(/:\d+$/, ":4000");

    // Create a new API key via the Hono API.
    const createRes = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/api-keys`,
      {
        data: { name: "e2e-test-key" },
        headers: {
          "content-type": "application/json",
          cookie: `oxagen.session_token=${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    expect(createRes.status()).toBe(201);
    const created = await createRes.json();

    // rawKey is returned exactly once and follows the aky_ prefix convention.
    expect(typeof created.rawKey).toBe("string");
    expect(created.rawKey.length).toBeGreaterThan(20);
    expect(created.publicId).toMatch(/^aky_/);
    expect(created.name).toBe("e2e-test-key");

    // Navigate to the tokens UI page — the new key must appear in the Active list.
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/developer/tokens`);

    await expect(page.getByText("e2e-test-key")).toBeVisible();
    // The status badge is a <span>; use .locator() to disambiguate from the
    // "Active" section heading that also matches getByText('Active').
    await expect(page.locator("span").filter({ hasText: /^Active$/ }).first()).toBeVisible();

    // The raw key is never shown in the UI — only the obfuscated prefix.
    await expect(page.getByText(created.rawKey)).not.toBeVisible();
  });

  test("revoke: key moves to revoked section on tokens UI page", async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(/:\d+$/, ":4000");

    // Create a key to revoke in this test (isolated from the previous test).
    const createRes = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/api-keys`,
      {
        data: { name: "e2e-revoke-target" },
        headers: {
          "content-type": "application/json",
          cookie: `oxagen.session_token=${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );
    expect(createRes.status()).toBe(201);
    const { publicId } = await createRes.json();

    // Revoke it.
    const revokeRes = await request.delete(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/api-keys/revoke`,
      {
        data: { keyPublicId: publicId },
        headers: {
          "content-type": "application/json",
          cookie: `oxagen.session_token=${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    expect(revokeRes.status()).toBe(200);
    const revoked = await revokeRes.json();
    expect(revoked.revoked).toBe(true);
    expect(revoked.keyPublicId).toBe(publicId);

    // Navigate to the tokens UI — key must now be in the Revoked / expired section.
    await loginWithSession(context, fixture.sessionToken, baseURL);
    await page.goto(`/${ORG_SLUG}/developer/tokens`);

    await expect(page.getByText("e2e-revoke-target")).toBeVisible();
    // The status badge is a <span>; use .locator() to disambiguate from the
    // "Revoked / expired" section heading that also matches getByText('Revoked').
    await expect(page.locator("span").filter({ hasText: /^Revoked$/ }).first()).toBeVisible();
  });

  test("revoked key is rejected by the API (auth guard)", async ({
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(/:\d+$/, ":4000");

    // Create then immediately revoke a key.
    const createRes = await request.post(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/api-keys`,
      {
        data: { name: "e2e-revoke-auth-check" },
        headers: {
          "content-type": "application/json",
          cookie: `oxagen.session_token=${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );
    expect(createRes.status()).toBe(201);
    const { publicId, rawKey } = await createRes.json();

    await request.delete(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/api-keys/revoke`,
      {
        data: { keyPublicId: publicId },
        headers: {
          "content-type": "application/json",
          cookie: `oxagen.session_token=${fixture.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    // Attempt to use the revoked rawKey as a Bearer token.
    const guardRes = await request.get(
      `${apiBase}/v1/${ORG_SLUG}/${WS_SLUG}/conversations`,
      {
        headers: { authorization: `Bearer ${rawKey}` },
        failOnStatusCode: false,
      },
    );

    expect(guardRes.status()).toBe(401);
  });
});
