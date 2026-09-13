/**
 * mcp-servers-authenticate.spec.ts
 *
 * E2E for the MCP server install → authenticate UX:
 *   1. Workspace Settings exposes an "MCP Registries" nav item that lands on
 *      Settings → MCP Server Registries (registry administration lives ONLY
 *      there). The MCP Servers page itself is a Workbench → Agent Tools
 *      section reached from the sidebar.
 *   2. The MCP Servers page renders the installed list, the marketplace
 *      catalog search, and the "Connect manually" form — and NO registry
 *      administration.
 *   3. Connecting a custom server with auth kind OAuth succeeds and immediately
 *      opens the post-install AuthenticateDialog ("Authentication required") —
 *      the server is installed but unusable until the OAuth consent flow runs.
 *      (The install itself never contacts the endpoint when OAuth is chosen
 *      explicitly, so an unreachable example endpoint is fine.)
 *   4. Dismissing with "Later" leaves the installed row in the
 *      "Needs authentication" state with an Authenticate action linking into
 *      GET /api/v1/mcp/oauth/authorize.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "mcp-servers-authenticate",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("MCP Servers — install → authenticate UX", () => {
  test("registries in settings → connect OAuth server → authenticate dialog → Later → Needs authentication row", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-auth" });
    const ws = `/${orgSlug}/default`;

    // ── 1. Workspace settings → "MCP Registries" (registry admin lives here) ─
    await gotoStable(page, `${ws}/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    const settingsNav = page.getByRole("navigation", { name: "Settings" });
    const registriesNavItem = settingsNav.getByRole("link", {
      name: "MCP Registries",
    });
    await expect(registriesNavItem).toBeVisible({ timeout: 20_000 });
    await registriesNavItem.click();
    await expect(page).toHaveURL(/\/settings\/mcp-server-registries$/, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("add-registry-btn")).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-settings-mcp-registries.png"),
      fullPage: true,
    });

    // ── 2. MCP Servers page: installed + marketplace + manual, NO registries ─
    await gotoStable(page, `${ws}/workbench/tools/mcp`);
    await expect(page.getByTestId("mcp-catalog-search-input")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Installed MCP servers")).toBeVisible();
    await expect(page.getByText("Connect manually")).toBeVisible();
    await expect(page.getByTestId("add-registry-btn")).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-mcp-servers-page.png"),
      fullPage: true,
    });

    // ── 3. Connect a custom OAuth server ─────────────────────────────────────
    await page.getByTestId("mcp-server-name-input").fill("E2E OAuth Server");
    await page
      .getByTestId("mcp-server-endpoint-input")
      .fill("https://e2e-oauth.example.com/mcp");
    // Pick the OAuth auth kind — the radio's label text is exactly "OAuth".
    await page.getByText("OAuth", { exact: true }).click();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-connect-form-filled-oauth.png"),
      fullPage: true,
    });

    await page.getByTestId("connect-mcp-submit-btn").click();

    // ── 4. Post-install authenticate dialog ─────────────────────────────────
    const dialog = page.getByTestId("mcp-authenticate-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Authentication required")).toBeVisible();
    await expect(
      dialog.getByText(/will not work until you authenticate/),
    ).toBeVisible();
    // The primary action names the server; do not click it — it navigates to
    // the provider's consent screen, which does not exist for this endpoint.
    await expect(
      dialog.getByRole("button", {
        name: "Authenticate with E2E OAuth Server",
      }),
    ).toBeEnabled();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-authenticate-dialog.png"),
      fullPage: true,
    });

    // ── 5. "Later" → installed row shows Needs authentication ───────────────
    await dialog.getByTestId("mcp-authenticate-later").click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The installed list (refreshed after install) carries the new row in the
    // unauthenticated state. Row ids are server-generated, so match by testid
    // prefix rather than a hard-coded id.
    const statusBadge = page
      .locator('[data-testid^="mcp-server-status-"]')
      .filter({ hasText: "Needs authentication" });
    await expect(statusBadge.first()).toBeVisible({ timeout: 30_000 });

    const authenticateLink = page
      .locator('[data-testid^="mcp-server-authenticate-"]')
      .first();
    await expect(authenticateLink).toBeVisible();
    await expect(authenticateLink).toHaveText(/Authenticate/);
    const href = await authenticateLink.getAttribute("href");
    expect(href).toContain("/api/v1/mcp/oauth/authorize?");
    expect(href).toContain(`returnTo=`);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-installed-needs-authentication.png"),
      fullPage: true,
    });
  });
});
