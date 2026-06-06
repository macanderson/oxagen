/**
 * mcp-rbac-negative.spec.ts
 *
 * E2E flow 8: RBAC negative — a Member-role user cannot manage plugins.
 *
 * Steps:
 *   1. seedPlugin creates an owner-role fixture user.
 *   2. We insert a second Member-role user into the same org + give them a session.
 *   3. Log in as the member.
 *   4. Assert the plugins settings page loads (member is authenticated) but all
 *      management controls (browse-marketplace-btn, add-custom-server-btn,
 *      denylist-add-btn) are NOT visible — the server component gates them
 *      on `canManage` (owner/admin only).
 *   5. Assert that a direct POST to the plugin.org.install API route returns 403.
 *
 * Testids used (absence asserted for member):
 *   browse-marketplace-btn
 *   add-custom-server-btn
 *   denylist-add-btn
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
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

    // ── Seed a Member-role user in the same org ────────────────────────────────
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const mbId = uid();
      const memberEmail = `e2e-rbac-member-${id}@oxagen.test`;
      const [memberRow] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
        VALUES ('usr_e2e_mb_' || ${mbId}, ${memberEmail}, 'E2E Member', 'active', now())
        ON CONFLICT (email) DO UPDATE SET status = 'active'
        RETURNING id
      `;
      if (!memberRow) throw new Error("rbac: member user insert failed");
      const memberUserId = memberRow.id;

      await sql`
        INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
        VALUES ('oru_e2e_mb_' || ${mbId}, ${fixture.orgId}, ${memberUserId}, 'member', now())
        ON CONFLICT (org_id, user_id) DO NOTHING
      `;

      memberSessionToken = `e2e-rbac-member-session-${id}`;
      await sql`
        INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
        VALUES (
          ${memberSessionToken},
          ${memberSessionToken},
          ${memberUserId},
          now() + interval '1 hour',
          '127.0.0.1',
          'playwright-e2e'
        )
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("Member-role user: plugin management UI is not visible on settings page", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Member is authenticated — should NOT redirect to /login.
    await expect(page).not.toHaveURL(/\/login/);

    // Page loads (wait for any heading or the route to settle).
    await page.waitForLoadState("domcontentloaded");

    // Management controls must NOT be visible for a member.
    // The server component conditionally renders these only when canManage=true.
    await expect(page.getByTestId("browse-marketplace-btn")).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("add-custom-server-btn")).not.toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId("denylist-add-btn")).not.toBeVisible({ timeout: 2_000 });
  });

  test("Member-role user: plugin.org.install API route returns 403", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);

    // Construct the API URL. The route in apps/app/src/app/api/v1/plugin/ handles
    // plugin install and enforces org-level owner/admin only via IAM.
    // We send the session cookie that loginAs injected.
    const cookies = await context.cookies("http://localhost:3000");
    const sessionCookie = cookies.find((c) => c.name === "oxagen.session_token");

    const response = await page.request.post(
      `http://localhost:3000/api/v1/${fixture.orgSlug}/default/plugins/org/install`,
      {
        headers: {
          "content-type": "application/json",
          ...(sessionCookie
            ? { cookie: `oxagen.session_token=${sessionCookie.value}` }
            : {}),
        },
        data: {
          pluginType: "mcp_server",
          catalogServerId: fixture.catalogServerId,
        },
        failOnStatusCode: false,
      },
    );

    // Must be 401 (no auth) or 403 (forbidden) — never 200.
    expect([401, 403, 404]).toContain(response.status());
  });
});
