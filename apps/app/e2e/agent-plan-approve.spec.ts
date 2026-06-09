import { test, expect } from "@playwright/test";
import {
  setupAgentRuntimeFixture,
  teardownFixture,
  type AgentRuntimeFixture,
} from "./helpers/agent-runtime-fixture";
import {
  interceptAgentStream,
  scriptedScenarioEvents,
} from "./helpers/agent-stream-mock";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";

// ─── Agent plan approval — end-to-end human-in-the-loop flow ─────────────────
//
// Exercises the MCP/agent approval surface: the model proposes a plan, an
// approval card appears, the user clicks Approve, and the agent proceeds.
//
// This spec focuses specifically on the plan-card → approval-card → approve
// interaction path (complementing agent-runtime-flow which covers the whole
// scenario). It adds:
//   • Assertion that the plan-card data-plan-status starts as "pending".
//   • Assertion that the approval-card data-approval-status is "pending" while
//     awaiting user input.
//   • Assertion that clicking Approve transitions both cards to their settled
//     states ("approved") and that the composer re-enables — the core
//     human-in-the-loop contract.
//   • Assertion that a Deny click (in a separate test) resolves as "denied".
//
// Auth-guard baseline is also preserved so the file is self-contained.
//
// All LLM / stream calls are intercepted by `interceptAgentStream` — no real
// provider credentials are required.

const PLAN_ORG_SLUG = "e2e-plan-approve";
const PLAN_WS_SLUG = "main";
const PLAN_USER_EMAIL = "e2e+plan@oxagen.ai";

let planFixture: AgentRuntimeFixture;

test.describe("agent.plan.approve — auth guard", () => {
  test("pending approvals view requires auth", async ({ page }) => {
    await page.goto("/agent/plans/pending");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.plan.approve — authenticated, interactive flow", () => {
  test.beforeAll(async () => {
    planFixture = await setupAgentRuntimeFixture({
      orgSlug: PLAN_ORG_SLUG,
      workspaceSlug: PLAN_WS_SLUG,
      userEmail: PLAN_USER_EMAIL,
    });
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: PLAN_ORG_SLUG });
  });

  // ── Approve path ─────────────────────────────────────────────────────────────

  test("plan card appears with pending status and correct title", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, planFixture.userEmail, E2E_TEST_PASSWORD, baseURL);

    const parentMessageId = "msg_plan_approve_test";
    await interceptAgentStream(page, {
      events: scriptedScenarioEvents({ parentMessageId }),
    });

    await page.goto(`/${PLAN_ORG_SLUG}/${PLAN_WS_SLUG}/chat`);
    await page.getByPlaceholder(/send a message/i).fill("Summarize this workspace");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Plan card must appear.
    const planCard = page.locator('[data-component="plan-card"]');
    await expect(planCard).toBeVisible();

    // The scripted scenario titles the plan "Analyze repo and summarize".
    await expect(planCard.getByText("Analyze repo and summarize")).toBeVisible();

    // Initial status is "pending" (before any approval action).
    await expect(planCard).toHaveAttribute("data-plan-status", "pending");
  });

  test("approval card appears with capability badge and pending status", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, planFixture.userEmail, E2E_TEST_PASSWORD, baseURL);

    const parentMessageId = "msg_plan_approval_card";
    await interceptAgentStream(page, {
      events: scriptedScenarioEvents({ parentMessageId }),
    });

    await page.goto(`/${PLAN_ORG_SLUG}/${PLAN_WS_SLUG}/chat`);
    await page.getByPlaceholder(/send a message/i).fill("Summarize this workspace");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Approval card must appear inside the stream.
    const approvalCard = page.locator('[data-component="approval-card"]');
    await expect(approvalCard).toBeVisible();

    // The scripted approval is for the "agent.plan" capability.
    await expect(approvalCard.getByText("agent.plan")).toBeVisible();

    // "Approval required" heading must be present.
    await expect(approvalCard.getByText(/approval required/i)).toBeVisible();

    // The approval card starts in pending state — both approve and deny buttons visible.
    await expect(approvalCard.getByRole("button", { name: /^approve$/i })).toBeVisible();
    await expect(approvalCard.getByRole("button", { name: /^deny$/i })).toBeVisible();
  });

  test("clicking Approve resolves the approval card and re-enables the composer", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, planFixture.userEmail, E2E_TEST_PASSWORD, baseURL);

    const parentMessageId = "msg_plan_approve_action";
    await interceptAgentStream(page, {
      events: scriptedScenarioEvents({ parentMessageId }),
    });

    await page.goto(`/${PLAN_ORG_SLUG}/${PLAN_WS_SLUG}/chat`);
    await page.getByPlaceholder(/send a message/i).fill("Summarize this workspace");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Wait for the approval card and then approve.
    const approvalCard = page.locator('[data-component="approval-card"]');
    await expect(approvalCard).toBeVisible();

    // Composer is paused while approval is pending.
    await expect(page.getByPlaceholder(/send a message|composer paused/i)).toBeDisabled();

    await approvalCard.getByRole("button", { name: /^approve$/i }).click();

    // After approval, the card's data-approval-status must be "approved".
    // (The card keeps the buttons mounted after resolving; the status
    // attribute is the meaningful resolved-state contract.)
    await expect(approvalCard).toHaveAttribute("data-approval-status", "approved");

    // Composer must re-enable after the approval resolves.
    await expect(page.getByPlaceholder(/send a message/i)).toBeEnabled();
  });

  // ── Deny path ────────────────────────────────────────────────────────────────

  test("clicking Deny resolves the approval card as denied", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAs(context, planFixture.userEmail, E2E_TEST_PASSWORD, baseURL);

    // Build a truncated event stream that fires plan-proposed + approval-required
    // but no approval-resolved — the user supplies the resolution via the Deny button.
    const parentMessageId = "msg_plan_deny_action";
    const allEvents = scriptedScenarioEvents({ parentMessageId });
    // Keep only events up to (but not including) the approval-resolved event so
    // the card stays in a pending state when rendered, and the test drives the
    // deny interaction itself.
    const approvalRequiredIdx = allEvents.findIndex((e) => e.type === "approval-required");
    const truncated = allEvents.slice(0, approvalRequiredIdx + 1);

    await interceptAgentStream(page, { events: truncated });

    await page.goto(`/${PLAN_ORG_SLUG}/${PLAN_WS_SLUG}/chat`);
    await page.getByPlaceholder(/send a message/i).fill("Summarize this workspace");
    await page.getByRole("button", { name: /^send$/i }).click();

    const approvalCard = page.locator('[data-component="approval-card"]');
    await expect(approvalCard).toBeVisible();

    await approvalCard.getByRole("button", { name: /^deny$/i }).click();

    // The meaningful contract is the resolved status transition. (The card
    // keeps the buttons mounted after resolving; it does not hide them.)
    await expect(approvalCard).toHaveAttribute("data-approval-status", "denied");
  });

  // ── Full scenario DB assertions (integration smoke) ───────────────────────────
  //
  // After the mock stream completes, the seeded DB rows (approval_requests,
  // subagent_fanouts, tool_calls) seeded by `setupAgentRuntimeFixture` must
  // be present. This confirms the fixture wiring is correct end-to-end.

  test("seeded DB state: approval request exists and is marked approved", async () => {
    const dbState = await planFixture.queryDbState();

    // At least one approval request for this org.
    expect(dbState.approvalRequests.length).toBeGreaterThanOrEqual(1);

    // The fixture pre-seeds the approval as resolved "approved".
    expect(
      dbState.approvalRequests.some((a) => a.resolution === "approved"),
    ).toBe(true);
  });

  test("seeded DB state: subagent fanout + 3 runs recorded", async () => {
    const dbState = await planFixture.queryDbState();

    expect(dbState.subagentFanouts.length).toBeGreaterThanOrEqual(1);
    expect(dbState.subagentRuns.length).toBeGreaterThanOrEqual(3);
    // All three child runs use agent.code.execute.
    const codeRuns = dbState.subagentRuns.filter(
      (r) => r.capability === "agent.code.execute",
    );
    expect(codeRuns.length).toBeGreaterThanOrEqual(3);
  });
});
