/**
 * chat-attachments.spec.ts — end-to-end coverage for chat attachments:
 * Phase 1 image upload/send/persist, and Phase 2 video attach + upload.
 *
 * Flow: sign up a fresh user, land on the chat page, attach a PNG via the
 * composer's paperclip file input (a REAL upload against
 * POST /api/v1/upload/attachment — private blob + generated_assets row, not
 * mocked), assert the pending chip reaches "uploaded", send a message with
 * the mocked assistant SSE stream (interceptAgentStream — no real LLM call),
 * and assert:
 *   - the live assistant reply bubble appears (the chat pipeline still works
 *     with an attachment present), and
 *   - after a fresh navigation (bypassing the mocked stream's held RSC
 *     refresh — see agent-stream-mock.ts), the PERSISTED user message row
 *     renders its attachment thumbnail (sendMessageAction really wrote
 *     `metadata.attachments`; message-bubble really reads it back).
 *
 * The assistant reply itself is never persisted (the SSE is mocked, so the
 * stream route's own persistAssistantTurn never runs) — only the user
 * message + its attachment survive the reload, which is exactly what this
 * spec is verifying.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored). Per repo
 * convention (see memories-bulk-import.spec.ts) the directory is created if
 * missing rather than wiped on every run — it is SHARED across all e2e spec
 * files, and Playwright runs spec files in parallel workers, so a per-spec
 * delete would race with other specs writing into the same directory.
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
    path: path.join(SCREENSHOT_DIR, `chat-attachments-${name}.png`),
    fullPage: true,
  });
}

// A minimal 1x1 transparent PNG — small enough to upload instantly, real
// enough to exercise assertAllowedAssetType's MIME sniff on the "image/png"
// content-type header (the route validates the declared type, not the bytes).
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function minimalTextEvents(messageId: string): StreamEvent[] {
  return [{ type: "text", messageId, text: "I can see the attached image." }];
}

test.describe("chat attachments — image upload, send, and persisted render", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test("uploads a PNG, shows the chip, sends, and renders the persisted thumbnail after reload", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "chat-attach",
    });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // The paperclip ("Attach image") button is only rendered when the
    // composer has an org+workspace scope — the real chat page always
    // provides one (message-composer.tsx `canAttach`).
    const attachBtn = page.getByRole("button", { name: /attach image/i });
    await expect(attachBtn).toBeVisible({ timeout: 10_000 });

    // The file input is intentionally hidden (aria-hidden, tabIndex=-1) —
    // Playwright's setInputFiles works on hidden inputs directly.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
    });

    // The pending chip appears immediately and reaches "uploaded" once the
    // real POST /api/v1/upload/attachment round-trip completes.
    const chip = page.getByTestId("attachment-chip");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute("data-status", "uploaded", {
      timeout: 15_000,
    });
    await shot(page, "01-chip-uploaded");

    // Send must be enabled again now that no upload is in flight.
    const sendBtn = page.getByRole("button", { name: /^send message$/i });
    await expect(sendBtn).toBeEnabled();

    const testMsgId = "e2e-msg-attachment-01";
    await interceptAgentStream(page, {
      events: minimalTextEvents(testMsgId),
      delayMs: 50,
    });

    await composer.fill("What is in this image?");
    await sendBtn.click();

    // The mocked assistant reply streams into the live turn container — the
    // chat pipeline still runs end-to-end with an attachment present.
    const liveTurn = page.locator("[data-live-turn]");
    await expect(liveTurn).toBeVisible({ timeout: 12_000 });
    await expect(liveTurn).toContainText(/I can see the attached image/i, {
      timeout: 10_000,
    });
    await shot(page, "02-assistant-reply-live");

    // Bypass the mock's held RSC refresh with a fresh full-document
    // navigation (agent-stream-mock only holds `rsc: 1` fetches to
    // /ask|/chat, not a plain reload) so the PERSISTED conversation state
    // renders: the user message row sendMessageAction actually wrote,
    // including its `metadata.attachments`.
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);

    const attachmentsStrip = page.getByTestId("message-attachments");
    await expect(attachmentsStrip).toBeVisible({ timeout: 15_000 });
    await expect(attachmentsStrip.locator("img")).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, "03-persisted-user-attachment");
  });

  test("attaches a video (Phase 2), uploads it as a video asset, and sends", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "chat-video",
    });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // Assert the video went up as a VIDEO asset by inspecting the upload
    // route's RESPONSE, not the request body. Chromium does not reliably
    // surface a multipart/form-data request body that carries a file part —
    // `request.postDataBuffer()` returns the bytes on some platforms (local
    // macOS) but null in CI's containerized Linux Chromium — so sniffing the
    // request for the "video" substring flakes by environment. The route's
    // 201 JSON (`{ publicId, kind, mimeType, ... }` — see
    // apps/app/src/app/api/v1/upload/attachment/route.ts) is a deterministic
    // signal that is also STRONGER: it proves the server actually persisted a
    // video asset (kind="video"), which is exactly what this case is named for.
    // The async predicate matches on the parsed body, so it locks onto the
    // video upload specifically even if a keyframe (kind="image") upload were
    // ever to race alongside it (a synthetic clip won't decode, so none do).
    const uploadRes = page.waitForResponse(
      async (res) => {
        if (
          !res.url().includes("/api/v1/upload/attachment") ||
          res.request().method() !== "POST" ||
          res.status() !== 201
        ) {
          return false;
        }
        const body = (await res.json().catch(() => null)) as {
          kind?: string;
        } | null;
        return body?.kind === "video";
      },
      { timeout: 20_000 },
    );

    const attachBtn = page.getByRole("button", {
      name: /attach image or video/i,
    });
    await expect(attachBtn).toBeVisible({ timeout: 10_000 });

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "clip.mp4",
      mimeType: "video/mp4",
      // A tiny buffer — the upload route validates the declared content-type,
      // not the bytes (same approach as the PNG case above).
      buffer: Buffer.from("fake-mp4-bytes"),
    });

    const uploadedAsset = (await (await uploadRes).json()) as { kind?: string };
    // The server persisted the upload as a video asset (not an image).
    expect(uploadedAsset.kind).toBe("video");

    // The video chip appears and reaches "uploaded" once the real upload lands.
    // There is exactly one VISIBLE chip (keyframes, if any, are hidden).
    const chip = page.getByTestId("attachment-chip");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute("data-status", "uploaded", {
      timeout: 15_000,
    });
    await shot(page, "04-video-chip-uploaded");

    const sendBtn = page.getByRole("button", { name: /^send message$/i });
    await expect(sendBtn).toBeEnabled({ timeout: 15_000 });

    const testMsgId = "e2e-msg-video-01";
    await interceptAgentStream(page, {
      events: [
        {
          type: "text",
          messageId: testMsgId,
          text: "I can see the attached video.",
        },
      ],
      delayMs: 50,
    });

    await composer.fill("What happens in this clip?");
    await sendBtn.click();

    const liveTurn = page.locator("[data-live-turn]");
    await expect(liveTurn).toBeVisible({ timeout: 12_000 });
    await expect(liveTurn).toContainText(/I can see the attached video/i, {
      timeout: 10_000,
    });
    await shot(page, "05-video-assistant-reply-live");
  });
});
