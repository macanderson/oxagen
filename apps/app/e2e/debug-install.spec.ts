import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { randomBytes } from "node:crypto";
import * as path from "path";
import * as fs from "fs";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("debug-install", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `dbg-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-dbg-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("debug install flow", async ({ page, context }) => {
    const screenshotDir = "/tmp/debug-screenshots";
    fs.mkdirSync(screenshotDir, { recursive: true });
    
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);
    
    // Open marketplace
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-modal")).toBeVisible();
    
    // Click MCP tab
    await page.getByTestId("marketplace-tab-mcp_server").click();
    
    // Wait for card
    const card = page.getByTestId(`marketplace-server-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    
    await page.screenshot({ path: path.join(screenshotDir, "1-before-card-click.png") });
    
    // Click card
    await card.click();
    
    // Wait for detail panel
    await expect(page.getByTestId("marketplace-detail-panel")).toBeVisible({ timeout: 5_000 });
    
    await page.waitForTimeout(2000); // wait for detail to fully load
    
    await page.screenshot({ path: path.join(screenshotDir, "2-detail-panel-visible.png") });
    
    // Intercept the install action response
    const responses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('settings/plugins')) {
        responses.push(`${response.status()} ${response.url()}`);
      }
    });
    
    // Check if install button is enabled 
    const installBtn = page.getByTestId("plugin-detail-install-btn");
    const isDisabled = await installBtn.isDisabled();
    console.log("Install button disabled:", isDisabled);
    
    // Check detail panel content
    const detailPanel = page.getByTestId("plugin-detail-panel");
    const panelText = await detailPanel.textContent();
    console.log("Detail panel text:", panelText?.substring(0, 200));
    
    await page.screenshot({ path: path.join(screenshotDir, "3-before-install-click.png") });
    
    // Click install
    await installBtn.click();
    
    await page.waitForTimeout(3000);
    
    await page.screenshot({ path: path.join(screenshotDir, "4-after-install-click.png") });
    
    // Check if there's an error displayed
    const errorEl = page.locator('[data-testid="plugin-detail-panel"] .text-destructive');
    const hasError = await errorEl.count() > 0;
    if (hasError) {
      const errorText = await errorEl.textContent();
      console.log("ERROR in detail panel:", errorText);
    }
    
    console.log("Responses:", responses);
    
    // Check if modal is still open
    const modalVisible = await page.getByTestId("marketplace-modal").isVisible();
    console.log("Modal still visible:", modalVisible);
  });
});
