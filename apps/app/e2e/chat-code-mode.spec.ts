/**
 * chat.code-mode — e2e spec.
 *
 * Code mode no longer has a manual toggle — it derives SOLELY from the
 * selected agent's definition (`selectedAgent.isCode`, see
 * message-composer.tsx). Picking a code agent through the chip's picker always
 * forces the inline repo + environment setup step before applying (see
 * agent-picker-panel.tsx's `applyAgent`/`confirmSetup`),
 * so the composer's own send-gate (`codeGateBlocked` / the
 * `code-mode-gate-hint` testid) is unreachable through that path — the
 * picker itself won't let you finish selecting a code agent without both.
 *
 * The gate IS reachable through the other documented way to enter code mode:
 * a `?agent=<publicId>` URL binding (see sessions/page.tsx, "binds this
 * session to a published agent"). That path seeds `selectedAgentId`, so code
 * mode turns on with only the environment auto-defaulted (workspace default)
 * — the repo stays unpicked whenever there is more than one candidate (see
 * message-composer.tsx's auto-fill effect, which only auto-picks a *sole*
 * repo). This spec exercises exactly that:
 *
 *   - Deep-linking `?agent=<codeAgentId>` with two seeded repos and no
 *     workspace-default repo preference: send stays BLOCKED with the
 *     "Select a repository and environment…" hint until a repo is picked in
 *     the chip's setup step (context is chosen once, not per turn — the
 *     composer itself has no repo/environment selectors).
 *   - Submitting the first turn POSTs /api/v1/chat/stream with a `code` field
 *     carrying { connectionId, owner, name, defaultBranch, environmentId,
 *     sandboxSessionId: null } matching the selected repo — asserted by
 *     intercepting the outgoing request (no real sandbox execution).
 *   - After that first send, the conversation's coding target LOCKS: the
 *     agent chip swaps to its read-only `agent-context-chip-locked` variant.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { seedConnectedGithubRepo } from "./helpers/seed-code-repo";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

/**
 * Create a code agent through the builder deterministically: skip the AI
 * describe step (no LLM), fill identity, flip on "Code features" (persists
 * agentType "code" → isCode), step through to Review with builder-next (there
 * is no single "jump to review" control), then save the draft. Returns the
 * created agent's public id (`agt_…`), read back from the URL — saving a new
 * draft moves the browser onto the durable edit route
 * (`/workbench/agents/{agentId}`) via `router.replace` (see
 * agent-builder.tsx's `persistDraft`).
 */
async function createCodeAgent(
  page: Page,
  orgSlug: string,
  opts: { name: string; slug: string },
): Promise<string> {
  await page.goto(`/${orgSlug}/default/workbench/agents/new`);
  await expect(page.getByTestId("step-describe")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("agent-describe-skip").click();
  await expect(page.getByTestId("step-identity")).toBeVisible();
  await page.getByTestId("agent-name-input").fill(opts.name);
  await page.getByTestId("agent-slug-input").fill(opts.slug);
  await page.getByTestId("agent-code-features-switch").click();

  // Identity → Prompt → Equip → Ground → Triggers → Review: click Next until
  // Review is visible (bounded so a stalled step fails fast with a clear
  // error instead of the outer test timeout).
  for (let i = 0; i < 10; i++) {
    if (await page.getByTestId("step-review").isVisible()) break;
    await page.getByTestId("builder-next").click();
  }
  await expect(page.getByTestId("step-review")).toBeVisible();
  await page.getByTestId("agent-save-draft").click();
  await expect(page.getByText(/draft saved/i)).toBeVisible({ timeout: 20_000 });

  // The "Draft saved" toast fires right after persistDraft() resolves, but
  // router.replace() onto the durable edit route is a separate async
  // navigation that can commit slightly AFTER the toast becomes visible —
  // wait for the URL itself to settle before reading the id back out of it.
  await page.waitForURL(
    (url) => {
      const segments = url.pathname.split("/").filter(Boolean);
      return segments[segments.length - 1] !== "new";
    },
    { timeout: 10_000 },
  );

  const segments = new URL(page.url()).pathname.split("/").filter(Boolean);
  const agentId = segments[segments.length - 1];
  if (!agentId || agentId === "new") {
    throw new Error(
      `createCodeAgent: could not resolve the agent id from URL "${page.url()}"`,
    );
  }
  return agentId;
}

test.describe("chat.code-mode", () => {
  test.beforeEach(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("blocks send until a repo is selected, sends the code payload, then locks the coding target", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "code-mode" });

    // Two repos on two distinct connections — with no workspace-default repo
    // preference set, resolveDefaultRepoKey() returns null and the
    // composer's auto-fill effect only auto-picks a *sole* repo (see
    // message-composer.tsx). With two candidates the repo stays unpicked, so
    // the send gate is genuinely observable rather than resolving on mount.
    const repoA = await seedConnectedGithubRepo({
      orgSlug,
      owner: "oxageninc",
      repo: "e2e-fixture-repo-a",
    });
    const repoB = await seedConnectedGithubRepo({
      orgSlug,
      owner: "oxageninc",
      repo: "e2e-fixture-repo-b",
    });
    try {
      const slug = `coder-${Date.now().toString(36)}`;
      const agentId = await createCodeAgent(page, orgSlug, {
        name: "Repo Coder",
        slug,
      });

      // `?agent=<publicId>` binds the session directly (sessions/page.tsx) — the
      // one path that turns code mode on WITHOUT going through the picker's
      // own repo+environment setup step, so the composer's own gate is
      // exercised.
      await page.goto(`/${orgSlug}/default/sessions?agent=${agentId}`);

      const composer = page.getByPlaceholder(/send a message/i);
      await expect(composer).toBeVisible({ timeout: 10_000 });

      const chip = page.getByRole("button", { name: "Agent: Repo Coder" });
      await expect(chip).toBeVisible();

      // The composer has no repo/environment selectors of its own: chat
      // context is chosen once, in the chip's setup step, and is immutable for
      // the conversation. What the composer still owns is the send GATE, which
      // is what this test is about.
      const sendBtn = page.getByRole("button", { name: /send message/i });
      const gateHint = page.getByTestId("code-mode-gate-hint");

      // Environment auto-defaults to the workspace's seeded "Default"; with
      // TWO candidate repos there is no sole option to auto-select, so the
      // repo stays unpicked and send stays gated.
      await expect(sendBtn).toBeDisabled();
      await expect(gateHint).toContainText(
        "Select a repository and environment to start coding.",
      );
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "code-mode-gate-blocked.png"),
      });

      // Select repo A through the chip's setup step — the one surface that
      // binds a code agent's target now. Re-picking the already-selected code
      // agent slides the step in; the environment is prefilled from the
      // composer's auto-filled workspace default, so only the repo is left.
      await chip.click();
      const picker = page.locator('[data-agent-picker="popover"]');
      await picker.getByRole("option", { name: /Repo Coder/ }).click();
      const repoTrigger = page.getByLabel("Session repository");
      await expect(repoTrigger).toBeVisible();
      await expect(page.getByLabel("Session environment")).toBeVisible();
      await repoTrigger.click();
      await page
        .getByRole("option", {
          name: `${repoA.owner}/${repoA.repo}`,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: /Chat with Repo Coder/ }).click();

      await expect(sendBtn).toBeEnabled();
      await expect(gateHint).toHaveCount(0);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "code-mode-gate-open.png"),
      });

      // Capture the outgoing POST body. Registered AFTER interceptAgentStream
      // so it runs FIRST (Playwright routes are LIFO) and hands off via
      // route.fallback() to the SSE mock underneath — the body is captured
      // without disturbing the mocked stream response.
      let capturedBody: Record<string, unknown> | null = null;
      await interceptAgentStream(page, {
        events: [
          { type: "text", messageId: "e2e-code-mode-msg", text: "Done." },
        ],
        delayMs: 30,
      });
      await page.route("**/api/v1/chat/stream", async (route: Route) => {
        capturedBody = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        await route.fallback();
      });

      await composer.fill("fix the failing test in src/index.ts");
      await sendBtn.click();

      await expect.poll(() => capturedBody).not.toBeNull();
      const body = capturedBody as unknown as { code: Record<string, unknown> };
      expect(body.code).toMatchObject({
        connectionId: repoA.connectionId,
        owner: repoA.owner,
        name: repoA.repo,
        defaultBranch: repoA.defaultBranch,
        environmentId: repoA.environmentId,
        sandboxSessionId: null,
      });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "code-mode-sent.png"),
      });

      // The conversation's coding target is now LOCKED for its lifetime
      // (lockSelection() fires synchronously in onSubmit — no reload needed).
      // The chip's read-only variant is the whole of what the lock renders;
      // ComposerContextControls has no caller in this flow.
      const lockedChip = page.getByTestId("agent-context-chip-locked");
      await expect(lockedChip).toBeVisible();
      await expect(lockedChip).toHaveAttribute(
        "aria-label",
        "Agent locked: Repo Coder",
      );
      await expect(chip).toHaveCount(0);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "code-mode-locked.png"),
      });
    } finally {
      await repoA.cleanup();
      await repoB.cleanup();
    }
  });

  test("sends code: null when code mode is off", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "code-mode-off",
    });

    await page.goto(`/${orgSlug}/default/sessions`);
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
