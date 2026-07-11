/**
 * chat.agent-picker — e2e spec for the redesigned agent-selection UX.
 *
 * Against the real stack:
 *   1. Create an agent via the Agent Builder so the workspace has one to pick.
 *   2. On a new chat, the empty-state gallery ("Choose your assistant") is
 *      visible; picking the agent updates the composer chip to reflect it and
 *      the outgoing /api/v1/chat/stream body carries the chosen agentId.
 *   3. The picker's per-agent star sets the workspace default assistant, which
 *      survives a reload (persisted via update_workspace_user_preferences).
 *   4. For a code agent (with a seeded GitHub repo), the picker slides in the
 *      repo + environment setup step; confirming applies the code session.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored). Write-only spec —
 * executed by CI, not locally.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { seedConnectedGithubRepo } from "./helpers/seed-code-repo";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

/**
 * Create an agent through the builder deterministically: skip the AI describe
 * step (no LLM), fill identity, optionally flip on "Code features" (persists
 * agentType "code" → isCode), then save the draft. Mirrors the proven flow in
 * agents-card-grid-avatars.spec.ts.
 */
async function createAgent(
  page: Page,
  orgSlug: string,
  opts: { name: string; slug: string; codeFeatures?: boolean },
): Promise<void> {
  await page.goto(`/${orgSlug}/default/workbench/agents/new`);
  await expect(page.getByTestId("step-describe")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("agent-describe-skip").click();
  await expect(page.getByTestId("step-identity")).toBeVisible();
  await page.getByTestId("agent-name-input").fill(opts.name);
  await page.getByTestId("agent-slug-input").fill(opts.slug);
  if (opts.codeFeatures) {
    // "Code features" switch (Identity step) → agentType "code".
    await page.getByTestId("agent-code-features-switch").click();
  }
  await page.getByTestId("builder-step-review").click();
  await expect(page.getByTestId("step-review")).toBeVisible();
  await page.getByTestId("agent-save-draft").click();
  await expect(page.getByText(/draft saved/i)).toBeVisible({ timeout: 20_000 });
}

test.describe("chat.agent-picker", () => {
  test.beforeEach(() => {
    if (fs.existsSync(SCREENSHOT_DIR))
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("gallery picks an agent, the chip reflects it, and it is sent + set as default", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "agent-picker",
    });
    // "chat-" (5) + an 8-char base36 timestamp = 13 chars, safely under
    // create_agent_def's 18-char slug cap. The previous "chat-helper-" prefix
    // (12 chars) pushed the generated slug to 20 chars — over the cap — so
    // every create_agent_def call failed zod validation ("too_big") and the
    // draft was never persisted, deterministically timing out the "draft
    // saved" toast wait below.
    const slug = `chat-${Date.now().toString(36)}`;
    await createAgent(page, orgSlug, { name: "Chat Helper", slug });

    // New chat — the empty-state gallery leads with "Choose your assistant".
    await page.goto(`/${orgSlug}/default/chat?new=1`);
    const gallery = page.getByTestId("agent-gallery");
    await expect(gallery).toBeVisible({ timeout: 15_000 });
    await expect(
      gallery.getByRole("heading", { name: "Choose your assistant" }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "agent-gallery.png"),
    });

    // Pick the agent from the gallery — a chat agent applies immediately.
    await gallery.getByRole("option", { name: /Chat Helper/ }).click();

    // The composer chip now reflects the selected agent.
    const chip = page.getByRole("button", { name: "Agent: Chat Helper" });
    await expect(chip).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "agent-chip-selected.png"),
    });

    // Sending a turn forwards the selected agentId in the stream body.
    let capturedBody: Record<string, unknown> | null = null;
    await interceptAgentStream(page, {
      events: [{ type: "text", messageId: "e2e-agent-msg", text: "Hi!" }],
      delayMs: 30,
    });
    await page.route("**/api/v1/chat/stream", async (route: Route) => {
      capturedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fallback();
    });
    await page.getByPlaceholder(/send a message/i).fill("hello there");
    await page.getByRole("button", { name: /send message/i }).click();
    await expect.poll(() => capturedBody).not.toBeNull();
    expect(
      typeof (capturedBody as unknown as { agentId: unknown }).agentId,
    ).toBe("string");

    // Star the agent as the workspace default via the chip's picker.
    await chip.click();
    await page
      .getByRole("button", { name: "Set Chat Helper as default assistant" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Remove Chat Helper as default assistant",
      }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "agent-default-starred.png"),
    });

    // The default survives a reload: a brand-new chat pre-selects it.
    await page.goto(`/${orgSlug}/default/chat?new=1`);
    await expect(
      page.getByRole("button", { name: "Agent: Chat Helper" }),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a code agent opens the repo + environment setup step before applying", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "agent-picker-code",
    });
    const seeded = await seedConnectedGithubRepo({ orgSlug });
    try {
      const slug = `coder-${Date.now().toString(36)}`;
      await createAgent(page, orgSlug, {
        name: "Repo Coder",
        slug,
        codeFeatures: true,
      });

      await page.goto(`/${orgSlug}/default/chat?new=1`);
      const gallery = page.getByTestId("agent-gallery");
      await expect(gallery).toBeVisible({ timeout: 15_000 });

      // The code agent's row carries a "code" badge; picking it slides in the
      // inline repo + environment setup step instead of applying immediately.
      const coderRow = gallery.getByRole("option", { name: /Repo Coder/ });
      await expect(coderRow).toBeVisible();
      await coderRow.click();

      await expect(
        page.getByRole("button", { name: /Chat with Repo Coder/ }),
      ).toBeVisible();
      const repoTrigger = page.getByLabel("Session repository");
      await expect(repoTrigger).toBeVisible();
      await expect(page.getByLabel("Session environment")).toBeVisible();
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "agent-code-setup-step.png"),
      });

      // Choose the seeded repo, then confirm — the chip reflects the code agent.
      await repoTrigger.click();
      await page
        .getByRole("option", { name: `${seeded.owner}/${seeded.repo}` })
        .click();
      await page.getByRole("button", { name: /Chat with Repo Coder/ }).click();
      await expect(
        page.getByRole("button", { name: "Agent: Repo Coder" }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "agent-code-confirmed.png"),
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
