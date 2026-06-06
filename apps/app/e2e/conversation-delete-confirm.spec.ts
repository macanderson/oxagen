/**
 * conversation.delete.confirm — e2e spec.
 *
 * Signs up a fresh user, creates a conversation by sending a message and
 * reloading, opens the per-row action menu, clicks Delete, CONFIRMS in the
 * dialog, and asserts the conversation row disappears from the nav.
 *
 * Gap covered: conversation-list.spec.ts covers the Cancel path of the delete
 * dialog but never exercises the Confirm path, so the actual delete server
 * action is untested by the existing suite.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("conversation.delete.confirm — delete via confirm dialog", () => {
  test("confirming delete removes the conversation from the nav", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conv-del" });

    // ── Step 1: create a conversation ────────────────────────────────────────
    await page.goto(`/${orgSlug}/default/ask`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    await composer.fill("A conversation to be deleted");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The server action persists the conversation before any model call.
    // Reload so the server-rendered nav list includes the new row.
    await page.goto(`/${orgSlug}/default/ask`);

    // ── Step 2: locate the conversation row ──────────────────────────────────
    const nav = page.getByRole("navigation", { name: /conversation history/i });
    const row = nav.getByText(/deleted|conversation/i).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // ── Step 3: open the action menu and click Delete ─────────────────────────
    await row.hover();
    await nav.getByRole("button", { name: /actions for/i }).first().click();

    const deleteItem = page.getByRole("menuitem", { name: /^delete$/i });
    await expect(deleteItem).toBeVisible({ timeout: 5_000 });
    await deleteItem.click();

    // ── Step 4: confirm in the dialog ─────────────────────────────────────────
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/delete conversation\?/i, {
      timeout: 5_000,
    });

    // Click the destructive confirm button (not Cancel).
    const confirmBtn = dialog.getByRole("button", { name: /^delete$/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // ── Step 5: dialog closes and row disappears ──────────────────────────────
    await expect(dialog).toHaveCount(0, { timeout: 8_000 });

    // The conversation row must no longer be visible in the nav. Reload to
    // re-fetch the server-rendered list and confirm the deletion is durable.
    await page.goto(`/${orgSlug}/default/ask`);
    // After deletion the nav should be empty (only the fresh user's single
    // conversation was deleted). An empty state or zero conversation rows is
    // the expected outcome — we assert the specific row text is absent.
    const deletedRow = page
      .getByRole("navigation", { name: /conversation history/i })
      .getByText(/a conversation to be deleted/i);
    await expect(deletedRow).toHaveCount(0);
  });
});

test.describe("conversation.delete.confirm — negative: cancel keeps conversation", () => {
  test("cancelling the delete dialog leaves the conversation in the nav", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conv-del-cancel" });

    await page.goto(`/${orgSlug}/default/ask`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    await composer.fill("A conversation that should survive cancel");
    await page.getByRole("button", { name: /^send$/i }).click();

    await page.goto(`/${orgSlug}/default/ask`);

    const nav = page.getByRole("navigation", { name: /conversation history/i });
    const row = nav.getByText(/survive|conversation/i).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.hover();
    await nav.getByRole("button", { name: /actions for/i }).first().click();
    await page.getByRole("menuitem", { name: /^delete$/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/delete conversation\?/i, {
      timeout: 5_000,
    });

    // Cancel — the dialog must close and the conversation must remain.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(dialog).toHaveCount(0);

    // Reload and verify the row is still present.
    await page.goto(`/${orgSlug}/default/ask`);
    const survivingNav = page.getByRole("navigation", {
      name: /conversation history/i,
    });
    // At least one conversation row must still exist (we just cancelled).
    await expect(survivingNav.locator("[role='listitem'], li, a").first()).toBeVisible({
      timeout: 8_000,
    });
  });
});
