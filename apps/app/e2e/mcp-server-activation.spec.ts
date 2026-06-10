/**
 * mcp-server-activation.spec.ts
 *
 * E2E tests for the MCP server per-turn activation picker in the chat composer.
 *
 * The McpServerPicker renders in the composer toolbar when the org has at least
 * one enabled+healthy workspace MCP server. It allows the user to toggle individual
 * servers on/off for the current turn, and sends the selected server publicIds as
 * `activeServerIds` in the POST /api/v1/chat/stream body.
 *
 * Test scenarios:
 *   1. No picker button when org has no MCP servers
 *   2. Picker opens on click and closes on click-outside
 *   3. Activating a server increments the badge count
 *   4. "Activate all" and "Deactivate all" toggle all switches
 *   5. Active server IDs appear in the stream request body
 *
 * Testids used:
 *   mcp-server-picker-btn  — the Server icon button in the composer toolbar
 *
 * aria selectors used:
 *   role="dialog" name="MCP server activation"  — the floating panel
 *   label="Activate {name}" / "Deactivate {name}"  — per-server switches
 *   text="Activate all" / "Deactivate all"  — bulk toggle buttons
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { seedMcpActivation, type McpActivationFixture } from "./helpers/seed-mcp-activation";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

// ── Scenario 1: no picker when no MCP servers ─────────────────────────────────

test.describe("mcp-server-activation — no servers", () => {
  test("MCP picker button is absent when org has no MCP servers", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-none" });
    await page.goto(`/${orgSlug}/default/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for the composer to render.
    await expect(page.locator("textarea[name='content']")).toBeVisible({ timeout: 10_000 });

    // The picker button must not be present.
    await expect(page.getByTestId("mcp-server-picker-btn")).not.toBeVisible();
  });
});

// ── Scenarios 2-5: org with one seeded+enabled server ─────────────────────────

test.describe("mcp-server-activation — with servers", () => {
  let fixture: McpActivationFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedMcpActivation({
      orgSlug: `mcp-act-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mcp-act-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  // Helper: navigate to the ask page as the fixture user.
  async function gotoAsk(page: Parameters<typeof loginAs>[0] & { goto: (url: string) => Promise<unknown> }, context: Parameters<typeof loginAs>[0]) {
    await loginAs(context as Parameters<typeof loginAs>[0], fixture.userEmail, E2E_TEST_PASSWORD);
    await (page as { goto: (url: string) => Promise<unknown> }).goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
  }

  test("picker button is visible when servers are installed", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    await expect(page.locator("textarea[name='content']")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("mcp-server-picker-btn")).toBeVisible({ timeout: 5_000 });
  });

  test("picker panel opens on click and closes on click-outside", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    const pickerBtn = page.getByTestId("mcp-server-picker-btn");
    await expect(pickerBtn).toBeVisible({ timeout: 10_000 });

    // Open the panel.
    await pickerBtn.click();
    const panel = page.getByRole("dialog", { name: "MCP server activation" });
    await expect(panel).toBeVisible({ timeout: 3_000 });

    // Click outside the panel (on the page heading area) to close.
    await page.mouse.click(10, 10);
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });

  test("activating a server increments the badge count to 1", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    const pickerBtn = page.getByTestId("mcp-server-picker-btn");
    await expect(pickerBtn).toBeVisible({ timeout: 10_000 });

    // Open picker, activate the server.
    await pickerBtn.click();
    const panel = page.getByRole("dialog", { name: "MCP server activation" });
    await expect(panel).toBeVisible({ timeout: 3_000 });

    // Toggle the server on. The switch aria-label is "Activate E2E Mock MCP".
    const serverSwitch = panel.getByRole("switch").first();
    await expect(serverSwitch).toBeVisible({ timeout: 3_000 });
    await serverSwitch.click();

    // The badge inside the button should now show "1".
    await expect(pickerBtn.locator("span")).toContainText("1");
  });

  test("Activate all enables all servers; Deactivate all disables them", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    const pickerBtn = page.getByTestId("mcp-server-picker-btn");
    await expect(pickerBtn).toBeVisible({ timeout: 10_000 });
    await pickerBtn.click();

    const panel = page.getByRole("dialog", { name: "MCP server activation" });
    await expect(panel).toBeVisible({ timeout: 3_000 });

    // "Activate all" — only visible when not all are active.
    const activateAllBtn = panel.getByRole("button", { name: /activate all/i });
    await expect(activateAllBtn).toBeVisible();
    await activateAllBtn.click();

    // All switches should be checked.
    const switches = panel.getByRole("switch");
    const count = await switches.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(switches.nth(i)).toHaveAttribute("aria-checked", "true");
    }

    // Button text flips to "Deactivate all".
    const deactivateAllBtn = panel.getByRole("button", { name: /deactivate all/i });
    await expect(deactivateAllBtn).toBeVisible();
    await deactivateAllBtn.click();

    // All switches should be unchecked.
    for (let i = 0; i < count; i++) {
      await expect(switches.nth(i)).toHaveAttribute("aria-checked", "false");
    }
  });

  test("active server IDs are included in the chat stream request body", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // Capture the stream request body before it fires.
    let capturedActiveServerIds: string[] | undefined;
    await page.route("**/api/v1/chat/stream", async (route) => {
      const request = route.request();
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        capturedActiveServerIds = body.activeServerIds as string[] | undefined;
      } catch {
        capturedActiveServerIds = [];
      }
      // Fulfill with a minimal SSE done response so the app doesn't hang.
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: "event: done\ndata: [DONE]\n\n",
      });
    });

    // Activate the server.
    const pickerBtn = page.getByTestId("mcp-server-picker-btn");
    await expect(pickerBtn).toBeVisible({ timeout: 10_000 });
    await pickerBtn.click();

    const panel = page.getByRole("dialog", { name: "MCP server activation" });
    await expect(panel).toBeVisible({ timeout: 3_000 });
    const serverSwitch = panel.getByRole("switch").first();
    await serverSwitch.click();

    // Close picker by clicking the button again.
    await pickerBtn.click();

    // Submit a message.
    const textarea = page.locator("textarea[name='content']");
    await textarea.fill("ping");
    await page.locator("button[aria-label='Send message']").click();

    // Wait for the route to fire.
    await page.waitForTimeout(2_000);

    // The captured body should include the fixture's MCP server publicId.
    expect(Array.isArray(capturedActiveServerIds)).toBe(true);
    expect(capturedActiveServerIds).toContain(fixture.mcpPublicId);
  });
});
