/**
 * conversation-files-zip.spec.ts — end-to-end coverage for the Files tab's
 * "Download all" ZIP affordance (shown only once a conversation has MORE THAN
 * ONE file).
 *
 * Flow: sign up a fresh user, send a first message with the mocked assistant
 * SSE (interceptAgentStream — no real LLM call) so the conversation persists
 * and the URL gains `?c=<publicId>`, reload (the composer now carries the
 * conversationId), then upload TWO PNGs through the composer's paperclip —
 * REAL uploads against POST /api/v1/upload/attachment, which links each
 * generated_assets row to the conversation at upload time. Toggling the right
 * rail's Workspace → Files tabs re-activates ConversationFilesList, which
 * refetches GET /api/v1/conversations/[id]/assets, and we assert:
 *   - the "2 files" count header and the "Download all" anchor appear, pointed
 *     at /api/v1/conversations/[id]/assets/archive, and
 *   - fetching that URL with the session cookies RESPONDS with a real ZIP:
 *     200, application/zip, attachment disposition, body starting with the
 *     "PK" local-file-header magic (assert on the RESPONSE, per repo memory —
 *     CI Chromium can't reliably surface multipart request bodies).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (shared dir, created if
 * missing — never wiped here; parallel workers write into it concurrently).
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `conversation-files-zip-${name}.png`),
    fullPage: true,
  });
}

// A minimal 1x1 transparent PNG — small enough to upload instantly, real
// enough for the upload route's declared-content-type validation.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function minimalTextEvents(messageId: string): StreamEvent[] {
  return [{ type: "text", messageId, text: "Here you go." }];
}

/** Upload one PNG via the hidden composer file input and await the 201. */
async function uploadPng(
  page: import("@playwright/test").Page,
  filename: string,
): Promise<void> {
  const uploaded = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/upload/attachment") &&
      res.request().method() === "POST" &&
      res.status() === 201,
    { timeout: 20_000 },
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
  });
  await uploaded;
}

test.describe("conversation files — Download all as ZIP", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test("offers Download all once two files exist, and the archive URL serves a real ZIP", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "files-zip" });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // First send persists the conversation and lands `?c=<publicId>` in the
    // URL — the composer needs that id so later uploads link to the
    // conversation at upload time. This spec is the one legitimate consumer
    // of allowConversationNavigation: it needs the `?c=` commit and reloads
    // right after, asserting nothing about streamed state surviving the
    // navigation (see InterceptOptions docs).
    await interceptAgentStream(page, {
      events: minimalTextEvents("e2e-msg-files-zip-01"),
      delayMs: 50,
      allowConversationNavigation: true,
    });
    await composer.fill("I will attach two files next.");
    await page.getByRole("button", { name: /^send message$/i }).click();
    await page.waitForURL(/\?c=/, { timeout: 15_000 });

    const conversationId = new URL(page.url()).searchParams.get("c");
    expect(conversationId).toBeTruthy();

    // Fresh navigation past the mock's held RSC refresh; the composer now
    // mounts with the conversationId from ?c=.
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByPlaceholder(/send a message/i)).toBeVisible({
      timeout: 10_000,
    });

    // Two REAL uploads — each creates a generated_assets row linked to the
    // conversation (upload route passes conversationId → asset.upload).
    await uploadPng(page, "first-diagram.png");
    await uploadPng(page, "second-diagram.png");

    // The Files tab's list fetched on mount (right after the reload above),
    // before these uploads existed, and ConversationFilesList only re-fetches
    // when it re-activates (see conversation-files.tsx). There is no
    // "Workspace" tab to toggle away to and back in this scenario to force
    // that re-activation — WorkspaceContextPanel only renders a Workspace tab
    // once a durable sandbox session is active (see
    // workspace-context-panel.tsx / findActiveSandboxSessionId), and this
    // spec's mocked turn is plain text with no sandbox tool call. A fresh
    // navigation re-mounts the panel, which fetches fresh — the same pattern
    // chat-attachments.spec.ts uses to observe persisted state past the
    // mock's held RSC refresh.
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
    const rail = page.locator("aside");

    // The bulk affordance appears only because MORE THAN ONE file exists.
    await expect(rail.getByText("2 files")).toBeVisible({ timeout: 15_000 });
    const downloadAll = rail.getByRole("link", {
      name: /download all 2 files as a zip archive/i,
    });
    await expect(downloadAll).toBeVisible();
    const href = await downloadAll.getAttribute("href");
    expect(href).toBe(`/api/v1/conversations/${conversationId}/assets/archive`);
    await shot(page, "01-download-all-visible");

    // Assert on the archive RESPONSE with the page's session cookies: a real
    // ZIP streams back — status, headers, and the PK local-file-header magic.
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");
    expect(res.headers()["content-disposition"]).toContain("attachment;");
    expect(res.headers()["content-disposition"]).toContain("-files.zip");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(4);
    // "PK\x03\x04" — first local file header of a non-empty ZIP.
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
    expect(body[2]).toBe(0x03);
    expect(body[3]).toBe(0x04);
  });
});
