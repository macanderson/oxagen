/**
 * agent.memory.recall — e2e spec.
 *
 * Asserts the memory explorer requires auth AND that an authenticated user
 * can reach their workspace (memory recall surfaces in the knowledge area).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.memory.recall — auth guard", () => {
  test("memory explorer requires auth", async ({ page }) => {
    await page.goto("/agent/memory");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.memory.recall — authenticated", () => {
  test("knowledge page is reachable for a fresh org's workspace", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mem-recall" });

    // Memory recall surfaces in the workspace knowledge area.
    await page.goto(`/${orgSlug}/default/knowledge`);
    await expect(page).not.toHaveURL(/\/login/);
    // Knowledge root redirects to /knowledge/sources.
    await expect(page).toHaveURL(/knowledge\/sources/);
    // Sources section heading confirms the page rendered.
    await expect(page.getByText("Sources").first()).toBeVisible();
  });
});
