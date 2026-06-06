/**
 * mcp-org-add-custom.spec.ts
 *
 * E2E flow 2: Add a custom MCP server and a custom registry to an org.
 *
 * Uses signUpFreshUser so each test runs in a brand-new org (no seedPlugin
 * needed — the forms are the subject under test, not the DB state).
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

// ── Add custom MCP server ──────────────────────────────────────────────────────

test.describe("mcp-org-add-custom — custom server", () => {
  test("owner can add a custom MCP server to the org allow-list", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-srv-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Show the custom server form.
    await page.getByTestId("add-custom-server-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-server-name-input").fill(`custom-mcp-${id}`);
    await page.getByTestId("custom-server-endpoint-input").fill(`${mockMcpUrl}/mcp`);
    await page.getByTestId("custom-server-submit-btn").click();

    // The new server should appear in the org allow-list table.
    await expect(page.getByText(`custom-mcp-${id}`)).toBeVisible({ timeout: 15_000 });
  });
});

// ── Add custom registry ────────────────────────────────────────────────────────

test.describe("mcp-org-add-custom — custom registry", () => {
  test("owner can add a custom registry", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-reg-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Show the registry form.
    await page.getByTestId("add-custom-registry-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-registry-name-input").fill(`E2E Registry ${id}`);
    await page.getByTestId("custom-registry-url-input").fill(mockMcpUrl);
    await page.getByTestId("custom-registry-submit-btn").click();

    // The new registry should appear in the registries table.
    await expect(page.getByText(`E2E Registry ${id}`)).toBeVisible({ timeout: 15_000 });
  });
});
