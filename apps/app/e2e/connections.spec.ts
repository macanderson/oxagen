/**
 * connections.spec.ts
 *
 * E2E tests for the Knowledge Sources page and GitHub connection wizard.
 *
 * Flow:
 *   1. Land on /knowledge/sources — see empty state when no connections exist.
 *   2. Click "Connect GitHub" — wizard opens at Step 1.
 *   3. Simulate OAuth return: navigate with ?setup=github&connectionId=X —
 *      wizard auto-advances to Step 2.
 *   4. Mock GitHub API responses for installations + repositories via page.route().
 *   5. Assert org list renders, select org, assert repo list updates.
 *   6. Select repos, click "Start Sync", assert wizard closes.
 *   7. Test: existing connection row shows status + has Re-sync button (DB-seeded).
 *   8. Test: Re-sync button fires and shows updated (spinning) status.
 *
 * API mocking strategy:
 *   - GitHub sub-resource API calls (installations, repositories) are intercepted
 *     via page.route() to avoid real GitHub OAuth token requirements.
 *   - The mappings PUT (Start Sync) is mocked via page.route().
 *   - For existing connections (tests 6/7), we seed real DB rows so the RSC
 *     page's server-side connection.list invoke() call returns them.
 *
 * Note: The RSC page calls invoke("connection.list") server-side, so
 * page.route() cannot intercept it. Tests 6/7 use DB seeding instead.
 */

import { test, expect } from "@playwright/test";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

function uid(): string {
  return randomBytes(4).toString("hex");
}

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

const MOCK_CONNECTION_ID = "con_e2e_test_001";
const MOCK_INSTALLATION_ID = 12345;
const MOCK_ORG_NAME = "oxagen-e2e";

// ── Shared fixture ─────────────────────────────────────────────────────────────

let fixture: PluginFixture;

test.describe("knowledge-sources connections", () => {
  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `conn-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-conn-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    // Clean up any seeded connection rows.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`
        DELETE FROM ingestion.source_connections
        WHERE org_id = ${fixture.orgId}
      `;
    } catch {
      // Ignore cleanup errors — the fixture cleanup handles org deletion.
    } finally {
      await sql.end({ timeout: 5 });
    }
    await fixture.cleanup();
  });

  // ── Test 1: Empty state ───────────────────────────────────────────────────────

  test("empty state shows when no connections exist", async ({ page, context }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources`);
    await expect(page).not.toHaveURL(/\/login/);

    // Empty state should be visible (no DB rows seeded yet for this test).
    const emptyState = page.getByTestId("connections-empty-state");
    await expect(emptyState).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 2: Open wizard from empty state ─────────────────────────────────────

  test("clicking Connect GitHub opens wizard at step 1", async ({ page, context }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources`);
    await expect(page.getByTestId("connections-empty-state")).toBeVisible({ timeout: 10_000 });

    // Click "Connect GitHub" in empty state.
    await page.getByTestId("connect-github-btn").click();

    // Wizard should open.
    const wizard = page.getByTestId("github-connection-wizard");
    await expect(wizard).toBeVisible({ timeout: 5_000 });

    // GitHub connect button should be visible in step 1.
    await expect(page.getByTestId("github-connect-btn")).toBeVisible();
  });

  // ── Test 3: OAuth return auto-advances to step 2 ──────────────────────────────

  test("returning from OAuth auto-advances wizard to step 2 with org list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Mock the GitHub installations endpoint (client-side call from wizard to Hono API).
    // Hono API is at localhost:4000 — the wizard uses NEXT_PUBLIC_API_URL.
    await page.route(
      `**/connections/github/installations*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            installations: [
              {
                id: MOCK_INSTALLATION_ID,
                accountLogin: MOCK_ORG_NAME,
                accountType: "Organization",
                repositorySelection: "selected",
                avatarUrl: null,
              },
            ],
          }),
        });
      },
    );

    // Navigate with ?setup=github&connectionId=X to simulate OAuth return.
    await page.goto(
      `/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources?setup=github&connectionId=${MOCK_CONNECTION_ID}`,
    );
    await expect(page).not.toHaveURL(/\/login/);

    // Wizard should auto-open at step 2.
    const wizard = page.getByTestId("github-connection-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Installation list should render with mock data.
    const installationList = page.getByTestId("installation-list");
    await expect(installationList).toBeVisible({ timeout: 10_000 });

    const orgItem = page.getByTestId(`installation-item-${MOCK_INSTALLATION_ID}`);
    await expect(orgItem).toBeVisible({ timeout: 5_000 });
    await expect(orgItem).toContainText(MOCK_ORG_NAME);
  });

  // ── Test 4: Repo list loads when org is selected ──────────────────────────────

  test("selecting org loads repository list", async ({ page, context }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Mock installations — the wizard appends ?connectionId=X so use trailing wildcard.
    await page.route(
      `**/connections/github/installations*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            installations: [
              {
                id: MOCK_INSTALLATION_ID,
                accountLogin: MOCK_ORG_NAME,
                accountType: "Organization",
                repositorySelection: "selected",
                avatarUrl: null,
              },
            ],
          }),
        });
      },
    );

    // Mock repositories for the selected installation (Hono API call).
    await page.route(
      `**/installations/${MOCK_INSTALLATION_ID}/repositories*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            repositories: [
              {
                id: 1001,
                name: "oxagen-monorepo",
                fullName: "oxagen/oxagen-monorepo",
                private: true,
                defaultBranch: "main",
                language: "TypeScript",
                description: "Oxagen monorepo",
              },
              {
                id: 1002,
                name: "oxagen-docs",
                fullName: "oxagen/oxagen-docs",
                private: false,
                defaultBranch: "main",
                language: "MDX",
                description: "Documentation",
              },
            ],
            totalCount: 2,
          }),
        });
      },
    );

    // Navigate with setup params.
    await page.goto(
      `/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources?setup=github&connectionId=${MOCK_CONNECTION_ID}`,
    );

    const wizard = page.getByTestId("github-connection-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Wait for installation list.
    await expect(page.getByTestId("installation-list")).toBeVisible({ timeout: 10_000 });

    // Click the org item.
    await page.getByTestId(`installation-item-${MOCK_INSTALLATION_ID}`).click();

    // Repository list should now appear.
    const repoList = page.getByTestId("repository-list");
    await expect(repoList).toBeVisible({ timeout: 10_000 });

    // Both repos should be visible.
    await expect(page.getByTestId("repo-checkbox-oxagen-monorepo")).toBeVisible();
    await expect(page.getByTestId("repo-checkbox-oxagen-docs")).toBeVisible();
  });

  // ── Test 5: Select repos + start sync ─────────────────────────────────────────

  test("selecting repos and clicking Start Sync completes wizard", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Mock installations — the wizard appends ?connectionId=X so use trailing wildcard.
    await page.route(
      `**/connections/github/installations*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            installations: [
              {
                id: MOCK_INSTALLATION_ID,
                accountLogin: MOCK_ORG_NAME,
                accountType: "Organization",
                repositorySelection: "selected",
                avatarUrl: null,
              },
            ],
          }),
        });
      },
    );

    // Mock repositories.
    await page.route(
      `**/installations/${MOCK_INSTALLATION_ID}/repositories*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            repositories: [
              {
                id: 1001,
                name: "oxagen-monorepo",
                fullName: "oxagen/oxagen-monorepo",
                private: true,
                defaultBranch: "main",
                language: "TypeScript",
                description: null,
              },
              {
                id: 1002,
                name: "oxagen-docs",
                fullName: "oxagen/oxagen-docs",
                private: false,
                defaultBranch: "main",
                language: "MDX",
                description: null,
              },
            ],
            totalCount: 2,
          }),
        });
      },
    );

    // Mock the mappings PUT (Start Sync — Hono API call).
    await page.route(
      `**/connections/${MOCK_CONNECTION_ID}/mappings*`,
      async (route) => {
        if (route.request().method() === "PUT") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              mappingsCreated: 1,
              mappingsUpdated: 0,
              connectionStatus: "active",
            }),
          });
        } else {
          await route.continue();
        }
      },
    );

    // Navigate with setup params.
    await page.goto(
      `/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources?setup=github&connectionId=${MOCK_CONNECTION_ID}`,
    );

    const wizard = page.getByTestId("github-connection-wizard");
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    // Wait for installations.
    await expect(page.getByTestId("installation-list")).toBeVisible({ timeout: 10_000 });

    // Select the org.
    await page.getByTestId(`installation-item-${MOCK_INSTALLATION_ID}`).click();

    // Wait for repos.
    await expect(page.getByTestId("repository-list")).toBeVisible({ timeout: 10_000 });

    // Select 2 repos.
    await page.getByTestId("repo-checkbox-oxagen-monorepo").check();
    await page.getByTestId("repo-checkbox-oxagen-docs").check();

    // Click Continue.
    await page.getByTestId("select-repos-next-btn").click();

    // Step 3 should appear.
    await expect(page.getByTestId("start-sync-btn")).toBeVisible({ timeout: 5_000 });

    // Click Start Sync.
    await page.getByTestId("start-sync-btn").click();

    // Success state / "Done" button should appear.
    await expect(page.getByTestId("wizard-done-btn")).toBeVisible({ timeout: 10_000 });
  });

  // ── Test 6: Existing connection shows status and Re-sync button (DB-seeded) ───

  test("existing connections show live status and Re-sync button", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Seed a real connection row in the DB so the RSC server-side call returns it.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    const connPubId = `con_e2e_active_${uid()}`;
    try {
      await sql`
        INSERT INTO ingestion.source_connections (
          public_id, org_id, workspace_id, connector_id, display_name,
          auth_scheme, delivery_method, status, entity_count,
          delivery_config
        )
        VALUES (
          ${connPubId},
          ${fixture.orgId},
          ${fixture.workspaceId},
          'github',
          'oxagen-monorepo',
          'oauth2_authorization_code',
          'webhook',
          'active',
          4820,
          '{"owner":"oxagen","repo":"monorepo","defaultBranch":"main"}'::jsonb
        )
        ON CONFLICT (public_id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    try {
      await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources`);
      await expect(page).not.toHaveURL(/\/login/);

      // Connection row should be visible.
      const row = page.getByTestId(`connection-row-${connPubId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Status should show "Synced".
      const status = page.getByTestId(`connection-status-${connPubId}`);
      await expect(status).toContainText(/synced/i);

      // Re-sync button should be visible for active connections.
      const resyncBtn = page.getByTestId(`resync-btn-${connPubId}`);
      await expect(resyncBtn).toBeVisible();
    } finally {
      // Clean up the seeded connection.
      const cleanSql = postgres(DATABASE_URL, { max: 2, prepare: false });
      await cleanSql`
        DELETE FROM ingestion.source_connections WHERE public_id = ${connPubId}
      `.catch(() => {});
      await cleanSql.end({ timeout: 5 });
    }
  });

  // ── Test 7: Re-sync button fires request and shows syncing status ──────────────

  test("Re-sync button fires request and shows Syncing status", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Seed a real connection row.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    const connPubId = `con_e2e_resync_${uid()}`;
    try {
      await sql`
        INSERT INTO ingestion.source_connections (
          public_id, org_id, workspace_id, connector_id, display_name,
          auth_scheme, delivery_method, status, entity_count,
          delivery_config
        )
        VALUES (
          ${connPubId},
          ${fixture.orgId},
          ${fixture.workspaceId},
          'github',
          'my-repo',
          'oauth2_authorization_code',
          'webhook',
          'active',
          1000,
          '{"owner":"oxagen","repo":"my-repo","defaultBranch":"main"}'::jsonb
        )
        ON CONFLICT (public_id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    let resyncCalled = false;

    // Mock the resync endpoint — the actual Hono API call goes to port 4000.
    // The wizard client makes a relative fetch which resolves to localhost:3000,
    // but Next.js proxies /api/v1 → localhost:4000 in dev. Mock both.
    await page.route(
      `**connections/${connPubId}/resync**`,
      async (route) => {
        if (route.request().method() === "POST") {
          resyncCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ queued: true }),
          });
        } else {
          await route.continue();
        }
      },
    );

    try {
      await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/knowledge/sources`);
      await expect(page).not.toHaveURL(/\/login/);

      // Wait for connection row.
      const row = page.getByTestId(`connection-row-${connPubId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Click Re-sync.
      await page.getByTestId(`resync-btn-${connPubId}`).click();

      // Status should update to "Syncing…".
      const status = page.getByTestId(`connection-status-${connPubId}`);
      await expect(status).toContainText(/syncing/i, { timeout: 5_000 });

      // Verify the API was called.
      expect(resyncCalled).toBe(true);
    } finally {
      // Clean up.
      const cleanSql = postgres(DATABASE_URL, { max: 2, prepare: false });
      await cleanSql`
        DELETE FROM ingestion.source_connections WHERE public_id = ${connPubId}
      `.catch(() => {});
      await cleanSql.end({ timeout: 5 });
    }
  });
});
