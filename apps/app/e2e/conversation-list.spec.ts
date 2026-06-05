/**
 * conversation.list — e2e spec.
 *
 * Exercises the workspace conversation-history nav on the /ask page: the nav
 * surface renders for an authenticated user, "New conversation" resets the
 * route, a sent message produces a listed conversation, the per-row action
 * menu opens, archiving is immediate (no dialog), and deleting always shows
 * the confirmation dialog. We do not depend on a real AI reply — the user
 * turn (and thus the conversation row) is persisted by the server action
 * before any model call.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("conversation.list — auth guard", () => {
  test("ask page redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/acme/default/ask");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("conversation.list — history nav surface", () => {
  test("authenticated user sees the conversation nav and New conversation action", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conv-list" });

    await page.goto(`/${orgSlug}/default/ask?c=anything`);
    await expect(page).not.toHaveURL(/\/login/);

    // The desktop secondary nav renders its heading and the New action.
    await expect(page.getByRole("heading", { name: /conversations/i })).toBeVisible({
      timeout: 10_000,
    });
    const newBtn = page.getByRole("button", { name: /new conversation/i }).first();
    await expect(newBtn).toBeVisible();

    // New conversation clears the ?c query (fresh composer state).
    await newBtn.click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/default/ask$`));
  });

  test("a sent message appears in the nav, archives without a dialog, and deletes behind a confirm", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conv-crud" });

    await page.goto(`/${orgSlug}/default/ask`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("First conversation about widgets");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The server action persists the conversation; reload to read it back from
    // the server-rendered nav list.
    await page.goto(`/${orgSlug}/default/ask`);
    const nav = page.getByRole("navigation", { name: /conversation history/i });
    const row = nav.getByText(/widgets|new conversation/i).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open the per-row action menu via its always-present button.
    await row.hover();
    await nav.getByRole("button", { name: /actions for/i }).first().click();
    await expect(page.getByRole("menuitem", { name: /^delete$/i })).toBeVisible();

    // Delete ALWAYS shows the confirmation dialog (hard delete).
    await page.getByRole("menuitem", { name: /^delete$/i }).click();
    await expect(page.getByRole("dialog")).toContainText(/delete conversation\?/i);

    // Cancel keeps the conversation.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Archive is immediate — no dialog appears.
    await row.hover();
    await nav.getByRole("button", { name: /actions for/i }).first().click();
    await page.getByRole("menuitem", { name: /^archive$/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
