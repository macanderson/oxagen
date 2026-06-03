/**
 * agent.approval.resolve — e2e spec.
 *
 * Asserts the approvals surface requires auth AND that an authenticated user
 * can reach their workspace (the approval resolution UI lives in the chat
 * stream, not on a standalone route). For a more complete flow see
 * agent-plan-approve.spec.ts which tests the full interactive approval path.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.approval.resolve — auth guard", () => {
  test("pending approvals view requires auth", async ({ page }) => {
    await page.goto("/agent/approvals");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.approval.resolve — authenticated", () => {
  test("workspace chat page is reachable (approval resolution surface)", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "approval-res" });

    // The approval resolution UI is in the chat stream within the workspace.
    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default`));
  });
});
