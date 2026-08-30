import { test, expect } from "@playwright/test";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";
import { loginWithSession } from "./helpers/auth";

// Verifies workspace isolation: a session scoped to workspace A within org X
// cannot access workspace B's pages or API resources within the same org.
//
// Two fixtures share the same orgSlug (ON CONFLICT DO UPDATE re-uses the org
// row) but use distinct workspaceSlugs and distinct userEmails — each user is
// only a member of their own workspace.

const ORG_SLUG = "e2e-ws-isolation";
const WS_ALPHA_SLUG = "ws-alpha";
const WS_BETA_SLUG = "ws-beta";

let alpha: AgentRuntimeFixture;
let beta: AgentRuntimeFixture;

test.describe("workspace.isolation — cross-workspace access denied", () => {
  test.beforeAll(async () => {
    // Both calls use the same orgSlug; the second reuses the org via ON CONFLICT.
    // bootstrapIam: true provisions full IAM (system roles + owner principal +
    // role assignment + role_grants) so both users pass the IAM-enforced
    // conversation.list gate on the API surface. Without it the kernel denies
    // the request (defaultEffect:"deny") → 403 on what should be a 200 baseline.
    [alpha, beta] = await Promise.all([
      setupAgentRuntimeFixture({
        orgSlug: ORG_SLUG,
        workspaceSlug: WS_ALPHA_SLUG,
        userEmail: "e2e+ws-alpha@oxagen.ai",
        bootstrapIam: true,
        // workspace-owner: assignment is scoped to ws-alpha, so the IAM gate
        // denies this user in ws-beta — the premise of every test below.
        // (An org-owner persona legitimately reaches all workspaces.)
        iamRole: "workspace-owner",
      }),
      setupAgentRuntimeFixture({
        orgSlug: ORG_SLUG,
        workspaceSlug: WS_BETA_SLUG,
        userEmail: "e2e+ws-beta@oxagen.ai",
        bootstrapIam: true,
        iamRole: "workspace-owner",
      }),
    ]);
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: ORG_SLUG });
  });

  test("page: ws-alpha session cannot reach ws-beta chat page", async ({
    page,
    context,
    baseURL,
  }) => {
    // Authenticate as the ws-alpha user.
    await loginWithSession(context, alpha.sessionToken, baseURL);

    // Attempt to navigate directly to ws-beta's ask/chat page.
    await page.goto(`/${ORG_SLUG}/${WS_BETA_SLUG}/ask`);

    // The proxy/middleware must either redirect to login or show an error page.
    // Accept /login redirect OR a 403/404 rendered page — both are valid
    // isolation responses. The 404 boundary is streamed RSC: it can land
    // AFTER goto() resolves, so wait for either outcome instead of checking
    // isVisible() at a single instant.
    const errorHeading = page
      .locator("h1, [data-testid='error-heading']")
      .filter({ hasText: /not found|forbidden|access denied|403|404/i });
    const denied = await Promise.any([
      page.waitForURL(/\/login/, { timeout: 10_000 }),
      errorHeading.first().waitFor({ state: "visible", timeout: 10_000 }),
    ])
      .then(() => true)
      .catch(() => false);

    expect(denied).toBe(true);

    // Must never see ws-beta workspace content.
    await expect(
      page.locator(`[data-workspace-slug="${WS_BETA_SLUG}"]`),
    ).not.toBeVisible();
  });

  test("api: ws-alpha session cannot list ws-beta conversations", async ({
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(
      /:\d+$/,
      ":4000",
    );

    const res = await request.get(
      `${apiBase}/v1/${ORG_SLUG}/${WS_BETA_SLUG}/conversations`,
      {
        headers: {
          cookie: `oxagen.session_token=${alpha.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    // The API must deny cross-workspace access — 403 Forbidden or 404 Not Found.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);

    // Response body must not leak ws-beta workspace ID.
    const body = await res.text();
    expect(body).not.toContain(beta.workspaceId);
  });

  test("api: ws-beta session can list its own conversations (baseline)", async ({
    request,
    baseURL,
  }) => {
    const apiBase = (baseURL ?? "http://localhost:3000").replace(
      /:\d+$/,
      ":4000",
    );

    const res = await request.get(
      `${apiBase}/v1/${ORG_SLUG}/${WS_BETA_SLUG}/conversations`,
      {
        headers: {
          cookie: `oxagen.session_token=${beta.sessionToken}`,
        },
        failOnStatusCode: false,
      },
    );

    // An authenticated ws-beta user must be able to reach their own workspace.
    // 200 = has conversations, 200 with empty list = also fine.
    expect(res.status()).toBe(200);

    const json = await res.json();
    // Response must not contain ws-alpha's workspace ID.
    expect(JSON.stringify(json)).not.toContain(alpha.workspaceId);
  });
});
