/**
 * agent.memory.write — e2e spec.
 *
 * Asserts the record-memory dialog requires auth AND that an authenticated
 * user can reach the knowledge area where memory write surfaces.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.memory.write — auth guard", () => {
  test("record-memory dialog requires auth", async ({ page }) => {
    await page.goto("/agent/memory/new");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.memory.write — authenticated", () => {
  test("knowledge page is reachable for a fresh org (memory write surface)", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mem-write" });

    await page.goto(`/${orgSlug}/default/knowledge`);
    await expect(page).not.toHaveURL(/\/login/);
    // Knowledge root redirects to /knowledge/sources.
    await expect(page).toHaveURL(/knowledge\/sources/);
    // Sources heading confirms the page rendered (write surface is on this page).
    await expect(page.getByText("Sources").first()).toBeVisible();
  });
});
