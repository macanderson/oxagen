/**
 * conversation-lifecycle.spec.ts — e2e coverage for the Ask surface's
 * conversation-history nav (apps/app/src/components/conversations/*):
 * list, rename, archive, delete, and purge-all-archived.
 *
 * Real UI, real DB writes, mocked LLM turn only:
 *   - sendMessageAction (apps/app/src/app/[orgSlug]/[workspaceSlug]/sessions/actions.ts)
 *     is a REAL server action — it inserts the conversation + user message rows
 *     into Postgres before the stream starts. Only the SSE reply
 *     (POST /api/v1/chat/stream) is intercepted via interceptAgentStream, so a
 *     conversation created this way is a real, listable row — no title is ever
 *     generated (that would need a real LLM call), so every fresh conversation
 *     falls back to "No session" until renamed. We rename conversation A
 *     immediately so its title stays a unique anchor for the rest of the test,
 *     distinguishing it from conversation B's untouched fallback title.
 *   - allowConversationNavigation: true on every interceptAgentStream call so
 *     the nav's client-side navigations (archiving the open conversation routes
 *     away; "No session" pushes `?new=1`) are NOT held by the mock's
 *     RSC-refresh guard — each one re-renders from the DB with live data,
 *     which is what the nav's `initialActive`/`initialArchived` reseed relies
 *     on to reflect a just-created or just-archived conversation.
 *
 * Flow: sign up → send conversation A → rename A → archive A → send
 * conversation B → archive B (now two archived conversations) → delete A
 * individually via its row menu → purge the remaining archived (B) via
 * "Delete all" → assert the archived section is empty.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function shot(page: Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `conversation-lifecycle-${name}.png`),
    fullPage: true,
  });
}

/** Opens the "Archived" collapsible section if it isn't already open. */
async function ensureArchivedOpen(nav: Locator): Promise<void> {
  const toggle = nav.getByRole("button", { name: /^archived/i });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

test.describe("conversation lifecycle — list, rename, archive, delete, purge", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test("manages a conversation through its full lifecycle via the nav UI", async ({
    page,
  }) => {
    test.setTimeout(150_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "conv-lifecycle",
    });

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const nav = page.locator('aside[aria-label="Conversations"]');
    await expect(nav).toBeVisible();

    // ── 1. Send the first message → conversation A is created & listed ──────
    await interceptAgentStream(page, {
      events: [
        { type: "text", messageId: "e2e-lifecycle-msg-a", text: "Reply A" },
      ],
      delayMs: 50,
      allowConversationNavigation: true,
    });
    await composer.fill("First conversation message");
    await page.getByRole("button", { name: /^send message$/i }).click();
    await page.waitForURL(/\?c=/, { timeout: 15_000 });
    const convAId = new URL(page.url()).searchParams.get("c");
    expect(convAId).toBeTruthy();

    // Fresh navigation past the mock's held RSC refresh — guarantees the nav
    // list reflects the just-created conversation from the DB rather than
    // racing the in-flight optimistic client state.
    await page.reload();
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const rowA = nav.getByRole("button", { name: "Actions for No session" });
    await expect(rowA).toBeVisible({ timeout: 10_000 });
    await shot(page, "01-conversation-a-listed");

    // ── 2. Rename conversation A ──────────────────────────────────────────
    await rowA.click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const renameDialog = page.getByRole("dialog", {
      name: "Rename conversation",
    });
    await expect(renameDialog).toBeVisible();
    await renameDialog
      .getByPlaceholder("Conversation title")
      .fill("Renamed E2E Conversation");
    await renameDialog.getByRole("button", { name: "Save" }).click();
    await expect(renameDialog).not.toBeVisible();
    await expect(nav.getByText("Renamed E2E Conversation")).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, "02-conversation-a-renamed");

    // ── 3. Archive conversation A (it's the currently-open conversation, so
    // archiving it routes away to a blank/new-conversation state) ──────────
    await nav
      .getByRole("button", { name: "Actions for Renamed E2E Conversation" })
      .click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.waitForURL((url) => !url.searchParams.get("c"), {
      timeout: 10_000,
    });
    await expect(nav.getByText("Renamed E2E Conversation")).not.toBeVisible({
      timeout: 10_000,
    });

    await ensureArchivedOpen(nav);
    await expect(nav.getByText("Renamed E2E Conversation")).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, "03-conversation-a-archived");

    // ── 4. Second conversation (conversation B) ─────────────────────────────
    await nav.getByRole("button", { name: "No session" }).click();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await interceptAgentStream(page, {
      events: [
        { type: "text", messageId: "e2e-lifecycle-msg-b", text: "Reply B" },
      ],
      delayMs: 50,
      allowConversationNavigation: true,
    });
    await composer.fill("Second conversation message");
    await page.getByRole("button", { name: /^send message$/i }).click();
    await page.waitForURL(/\?c=/, { timeout: 15_000 });
    const convBId = new URL(page.url()).searchParams.get("c");
    expect(convBId).toBeTruthy();
    expect(convBId).not.toBe(convAId);

    await page.reload();
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const rowB = nav.getByRole("button", { name: "Actions for No session" });
    await expect(rowB).toBeVisible({ timeout: 10_000 });
    await shot(page, "04-conversation-b-listed");

    // Archive conversation B too, so two archived conversations exist —
    // enough to exercise both a single delete and a bulk purge below.
    await rowB.click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.waitForURL((url) => !url.searchParams.get("c"), {
      timeout: 10_000,
    });

    await ensureArchivedOpen(nav);
    await expect(nav.getByText("Renamed E2E Conversation")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      nav.getByRole("button", { name: "Actions for No session" }),
    ).toBeVisible({ timeout: 10_000 });
    await shot(page, "05-both-archived");

    // ── 5. Delete conversation A (the renamed, archived one) individually ──
    await nav
      .getByRole("button", { name: "Actions for Renamed E2E Conversation" })
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete conversation?",
    });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(nav.getByText("Renamed E2E Conversation")).not.toBeVisible({
      timeout: 10_000,
    });
    // Conversation B (still archived) survives the single delete.
    await expect(
      nav.getByRole("button", { name: "Actions for No session" }),
    ).toBeVisible();
    await shot(page, "06-conversation-a-deleted");

    // ── 6. Purge all remaining archived conversations ───────────────────────
    const purgeButton = nav.getByRole("button", { name: "Delete all" });
    await expect(purgeButton).toBeVisible({ timeout: 10_000 });
    await purgeButton.click();
    const purgeDialog = page.getByRole("dialog", {
      name: "Delete all archived?",
    });
    await expect(purgeDialog).toBeVisible();
    await purgeDialog.getByRole("button", { name: "Delete all" }).click();
    await expect(purgeDialog).not.toBeVisible();
    await expect(nav.getByText("No archived conversations.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      nav.getByRole("button", { name: "Actions for No session" }),
    ).not.toBeVisible();
    await shot(page, "07-archived-purged-empty");
  });
});
