/**
 * coding-agent-trace — e2e spec.
 *
 * Drives a chat turn that invokes `agent.code.execute` plus a large-output
 * shell run and a repo edit, via a scripted SSE mock (no real sandbox/model
 * calls), and asserts the Phase 4 composition renders:
 *   - the inline `terminal-trace` card (large-output agent.sandbox.exec run)
 *   - the inline `code-diff` card (a mocked file edit)
 *   - the coding-trace-panel rail's stage rows (Plan / Tool calls / Code
 *     runs / Result), each deep-linking to `#turn-entry-<key>`
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function scriptedCodingTurnEvents(parentMessageId: string): StreamEvent[] {
  const m = parentMessageId;
  return [
    {
      type: "plan-proposed",
      planId: "pln_trace_1",
      title: "Fix the failing build",
      steps: [
        {
          id: "s1",
          summary: "Run the build to see the failure",
          intent: "Reproduce the error before touching code.",
          capability: "execute_code",
          dependsOn: [],
        },
        {
          id: "s2",
          summary: "Patch the offending file",
          intent: "Apply a targeted fix.",
          capability: "put_repo_file",
          dependsOn: ["s1"],
        },
      ],
    },
    { type: "plan-resolved", planId: "pln_trace_1", decision: "approved" },

    // A large-output shell run — rendered as an inline "terminal-trace" card
    // (componentId dispatched via a "component" event, mirroring what
    // capability-meta's resolveRenderDirective does server-side for big
    // agent.sandbox.exec output).
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_build",
      capability: "run_sandbox_command",
      inputPreview: { command: "pnpm --filter @oxagen/app build" },
      riskLevel: "medium",
    },
    {
      type: "component",
      toolCallId: "tcl_build",
      componentId: "terminal-trace",
      props: {
        command: "pnpm --filter @oxagen/app build",
        stdout: Array.from(
          { length: 50 },
          (_, i) => `[build] step ${i + 1}/50 ok`,
        ).join("\n"),
        stderr: "",
        exitCode: 1,
        durationMs: 4200,
      },
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_build",
      status: "completed",
      output: { exitCode: 1 },
      durationMs: 4200,
    },

    // A generic (non-code) tool call — lands in the rail's "Tool calls" bucket.
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_lookup",
      capability: "graph.query",
      inputPreview: { query: "recent build failures" },
      riskLevel: "low",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_lookup",
      status: "completed",
      output: { count: 1 },
      durationMs: 90,
    },

    // A direct agent.code.execute run — inline CodeExecuteCard, "Code runs" bucket.
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_code",
      capability: "execute_code",
      inputPreview: { language: "node", code: "console.log('rebuilding');" },
      riskLevel: "medium",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_code",
      status: "completed",
      output: { exitCode: 0 },
      durationMs: 210,
    },

    // A repo file edit — rendered inline as the "code-diff" card.
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_edit",
      capability: "put_repo_file",
      inputPreview: { path: "apps/app/src/lib/build-config.ts" },
      riskLevel: "medium",
    },
    {
      type: "component",
      toolCallId: "tcl_edit",
      componentId: "code-diff",
      props: {
        summary: "Fixed the stale build-config import.",
        files: [
          {
            path: "apps/app/src/lib/build-config.ts",
            patch:
              "@@ -1,3 +1,3 @@\n" +
              " export const BUILD_CONFIG = {\n" +
              '-  target: "es2019",\n' +
              '+  target: "es2022",\n' +
              " };\n",
            additions: 1,
            deletions: 1,
          },
        ],
      },
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_edit",
      status: "completed",
      output: { commitUrl: "https://github.com/acme/repo/commit/abc123" },
      durationMs: 150,
    },

    {
      type: "text",
      messageId: m,
      text: "Fixed the build — target bumped to es2022.",
    },
    {
      type: "usage",
      usage: {
        promptTokens: 512,
        completionTokens: 128,
        totalTokens: 640,
        creditsCharged: 4,
      },
    },
  ];
}

test.describe("coding-agent-trace", () => {
  // beforeAll (not beforeEach): this describe block has two tests that each
  // capture their own screenshot — a beforeEach would wipe the first test's
  // screenshot out from under it when the second test starts.
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("renders the terminal-trace + code-diff cards and the coding-trace-panel rail", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "coding-trace",
    });

    await page.goto(`/${orgSlug}/default/sessions`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // The parentMessageId doesn't need to match a real persisted message —
    // the mock only needs it to correlate the scripted events' `messageId`.
    const parentMessageId = "msg_parent_trace";
    await interceptAgentStream(page, {
      events: scriptedCodingTurnEvents(parentMessageId),
      delayMs: 40,
    });

    await composer.fill("Fix the failing build.");
    await page.getByRole("button", { name: /send message/i }).click();

    // Inline cards render in the transcript.
    const terminalTrace = page.locator(
      '[data-component="terminal-trace-card"]',
    );
    await expect(terminalTrace).toBeVisible({ timeout: 10_000 });
    const codeDiff = page.locator('[data-component="code-diff-card"]');
    await expect(codeDiff).toBeVisible({ timeout: 10_000 });

    // The coding-trace-panel rail groups the same turn into stages, each row
    // deep-linking to its inline card via #turn-entry-<key>.
    const rail = page.locator('[data-component="coding-trace-panel"]');
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(rail.getByText("Plan")).toBeVisible();
    await expect(rail.getByText("Tool calls")).toBeVisible();
    await expect(rail.getByText("Code runs")).toBeVisible();

    const codeRow = page.getByTestId("trace-row-tool:tcl_code");
    await expect(codeRow).toBeVisible();
    await expect(codeRow).toHaveAttribute("href", "#turn-entry-tool:tcl_code");

    const buildRow = page.getByTestId("trace-row-tool:tcl_build");
    await expect(buildRow).toBeVisible();
    await expect(buildRow).toHaveAttribute(
      "href",
      "#turn-entry-tool:tcl_build",
    );

    // The turn-entry anchor exists on the terminal-trace card's TimelineItem
    // wrapper, so the rail's link actually resolves to something in the DOM.
    await expect(page.locator("#turn-entry-tool\\:tcl_build")).toHaveCount(1);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "coding-agent-trace-success.png"),
      fullPage: true,
    });

    // Clicking a rail row scrolls the transcript to the matching card —
    // verified by checking the anchor becomes the in-view element.
    await codeRow.click();
    await expect(page.locator("#turn-entry-tool\\:tcl_code")).toBeInViewport();

    // The inline CodeExecuteCard is COLLAPSED by default — tool input (the
    // code) and output never render expanded in the conversation. Expanding
    // via the header reveals the code block.
    const codeCard = page.locator('[data-component="code-execute-card"]');
    await expect(codeCard).toBeVisible();
    await expect(codeCard.getByText("console.log('rebuilding');")).toBeHidden();
    await codeCard
      .getByRole("button", { name: /expand code run details/i })
      .click();
    await expect(
      codeCard.getByText("console.log('rebuilding');"),
    ).toBeVisible();

    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "coding-agent-trace-code-card-expanded.png",
      ),
      fullPage: true,
    });
  });

  test("shows the workspace-context-panel's Workspace tab once a sandbox session starts", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "coding-trace-ws",
    });

    await page.goto(`/${orgSlug}/default/sessions`);
    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // The Workspace tab's file tree calls through to the Hono API via the
    // next.config fallback rewrite (agent.sandbox_file.list) — mock it here
    // so the spec stays deterministic and never touches a real sandbox.
    await page.route("**/agent/sandbox/files", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entries: [
            { path: "src", kind: "dir" },
            { path: "src/index.ts", kind: "file", sizeBytes: 128 },
          ],
        }),
      }),
    );

    const parentMessageId = "msg_parent_trace_ws";
    const events: StreamEvent[] = [
      {
        type: "tool-call-start",
        messageId: parentMessageId,
        toolCallId: "tcl_sandbox_start",
        capability: "start_sandbox",
        inputPreview: {},
        riskLevel: "low",
      },
      {
        type: "tool-call-end",
        toolCallId: "tcl_sandbox_start",
        status: "completed",
        output: { sessionId: "sbx_e2e_1" },
        durationMs: 800,
      },
      { type: "text", messageId: parentMessageId, text: "Sandbox is up." },
      {
        type: "usage",
        usage: {
          promptTokens: 64,
          completionTokens: 16,
          totalTokens: 80,
          creditsCharged: 1,
        },
      },
    ];
    await interceptAgentStream(page, { events, delayMs: 40 });

    await composer.fill("Start a sandbox.");
    await page.getByRole("button", { name: /send message/i }).click();

    const panel = page.locator(
      '[data-component="workspace-context-panel-tabs"]',
    );
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const workspaceTab = panel.getByRole("tab", { name: /workspace/i });
    await expect(workspaceTab).toBeVisible({ timeout: 10_000 });

    // The panel auto-switches to the Workspace tab the first time a sandbox
    // appears — its file tree (fetched via the mocked route above) is visible.
    // FileTreeCard renders each row's leaf name ("index.ts"); the full
    // relative path ("src/index.ts") is the row's accessible name/title.
    await expect(
      panel.getByRole("button", { name: "View src/index.ts" }),
    ).toBeVisible({ timeout: 10_000 });

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "coding-agent-trace-workspace-tab.png"),
      fullPage: true,
    });
  });
});
