/**
 * chat.code-mode — e2e spec.
 *
 * Signs up a fresh user and exercises the chat composer's "Code" mode gate:
 *   - With no GitHub repos configured, the Code toggle is disabled.
 *   - After seeding a `connected` GitHub connection (seed-code-repo.ts) and a
 *     reload, the toggle is enabled; turning code mode on auto-selects the
 *     workspace's seeded "Default" environment but leaves the repo unpicked —
 *     send stays BLOCKED with the "Select a repository and environment…" hint.
 *   - Selecting the repo opens the gate.
 *   - Submitting the turn POSTs /api/v1/chat/stream with a `code` field
 *     carrying { connectionId, owner, name, defaultBranch, environmentId,
 *     sandboxSessionId: null } that matches the seeded connection — asserted
 *     by intercepting the outgoing request (no real sandbox execution).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */

import { test, expect, type Route } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { seedConnectedGithubRepo } from "./helpers/seed-code-repo";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

test.describe("chat.code-mode", () => {
  test.beforeEach(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("blocks send until a repo + environment are selected, then sends the code payload", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "code-mode" });

    await page.goto(`/${orgSlug}/default/chat`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const codeToggle = page.getByRole("button", { name: "Toggle code mode" });
    await expect(codeToggle).toBeVisible();

    // No GitHub connections exist yet for this fresh org — the toggle is
    // disabled (see message-composer.tsx's `!hasRepos && !codeMode` guard).
    await expect(codeToggle).toBeDisabled();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "code-mode-toggle-disabled.png") });

    // Seed a `connected` GitHub connection with a resolvable owner/repo, then
    // reload so the RSC (_shared/code-mode-data.ts) re-fetches the repo list.
    const seeded = await seedConnectedGithubRepo({ orgSlug });
    try {
      await page.reload();
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await expect(codeToggle).toBeEnabled();

      await codeToggle.click();

      const repoTrigger = page.getByRole("combobox", { name: "Select repository" });
      const envTrigger = page.getByRole("combobox", { name: "Select environment" });
      await expect(repoTrigger).toBeVisible();
      await expect(envTrigger).toBeVisible();

      const sendBtn = page.getByRole("button", { name: /send message/i });
      const gateHint = page.getByTestId("code-mode-gate-hint");

      // Environment auto-defaults to the workspace's seeded "Default", but the
      // repo is still unpicked — send stays gated.
      await expect(sendBtn).toBeDisabled();
      await expect(gateHint).toContainText("Select a repository and environment to start coding.");
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "code-mode-gate-blocked.png") });

      // Select the seeded repo.
      await repoTrigger.click();
      await page.getByRole("option", { name: `${seeded.owner}/${seeded.repo}` }).click();

      await expect(sendBtn).toBeEnabled();
      await expect(gateHint).toHaveCount(0);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "code-mode-gate-open.png") });

      // Capture the outgoing POST body. Registered AFTER interceptAgentStream
      // so it runs FIRST (Playwright routes are LIFO) and hands off via
      // route.fallback() to the SSE mock underneath — the body is captured
      // without disturbing the mocked stream response.
      let capturedBody: Record<string, unknown> | null = null;
      await interceptAgentStream(page, {
        events: [{ type: "text", messageId: "e2e-code-mode-msg", text: "Done." }],
        delayMs: 30,
      });
      await page.route("**/api/v1/chat/stream", async (route: Route) => {
        capturedBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fallback();
      });

      await composer.fill("fix the failing test in src/index.ts");
      await sendBtn.click();

      await expect.poll(() => capturedBody).not.toBeNull();
      const body = capturedBody as unknown as { code: Record<string, unknown> };
      expect(body.code).toMatchObject({
        connectionId: seeded.connectionId,
        owner: seeded.owner,
        name: seeded.repo,
        defaultBranch: seeded.defaultBranch,
        environmentId: seeded.environmentId,
        sandboxSessionId: null,
      });

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "code-mode-sent.png") });
    } finally {
      await seeded.cleanup();
    }
  });

  test("sends code: null when code mode is off", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "code-mode-off" });

    await page.goto(`/${orgSlug}/default/chat`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    let capturedBody: Record<string, unknown> | null = null;
    await interceptAgentStream(page, {
      events: [{ type: "text", messageId: "e2e-no-code-msg", text: "Hi." }],
      delayMs: 30,
    });
    await page.route("**/api/v1/chat/stream", async (route: Route) => {
      capturedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fallback();
    });

    await composer.fill("hello");
    await page.getByRole("button", { name: /send message/i }).click();

    await expect.poll(() => capturedBody).not.toBeNull();
    expect((capturedBody as unknown as { code: unknown }).code).toBeNull();
  });
});
