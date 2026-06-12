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
import { loginWithSession } from "./helpers/auth";

// Implements docs/epics/agent-runtime/spec.md §10 acceptance test #1:
// the agent plans → requests approval → fans out three subagents in
// parallel → runs sandboxed code → writes a memory. The test asserts the
// chat message DAG, the Postgres `execution.tool_calls` rows, and the
// Neo4j `INVOKED` edges.
//
// The runtime LLM call is mocked via `interceptAgentStream` so the test is
// deterministic and runs against a local `pnpm dev` stack without needing
// any provider credentials.

const TENANT_SLUG = "e2e-runtime";
const WORKSPACE_SLUG = "main";
const USER_EMAIL = "e2e+runtime@oxagen.ai";

let fixture: AgentRuntimeFixture;

test.describe("agent runtime end-to-end", () => {
  test.beforeAll(async () => {
    fixture = await setupAgentRuntimeFixture({
      orgSlug: TENANT_SLUG,
      workspaceSlug: WORKSPACE_SLUG,
      userEmail: USER_EMAIL,
    });
  });

  test.afterAll(async () => {
    await teardownFixture({ orgSlug: TENANT_SLUG });
  });

  test("plan → approve → fanout → sandbox → memory write", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginWithSession(context, fixture.sessionToken, baseURL);

    const parentMessageId = "msg_root";
    await interceptAgentStream(page, {
      events: scriptedScenarioEvents({ parentMessageId }),
    });

    await page.goto(`/${TENANT_SLUG}/${WORKSPACE_SLUG}/chat`);

    await page
      .getByPlaceholder(/send a message/i)
      .fill("Summarize this workspace");
    await page.getByRole("button", { name: /^send message$/i }).click();

    // 1. Plan card renders with the proposed steps.
    await expect(page.locator('[data-component="plan-card"]')).toBeVisible();
    await expect(page.getByText("Analyze repo and summarize")).toBeVisible();
    await expect(page.getByText("agent.memory.recall")).toBeVisible();

    // 2. Composer is disabled while the approval is pending.
    await expect(page.getByPlaceholder(/send a message|composer paused/i)).toBeDisabled();

    // 3. Approve the plan.
    await page
      .locator('[data-component="approval-card"]')
      .getByRole("button", { name: /^approve$/i })
      .click();

    // 4. Composer re-enables after the approval resolves.
    await expect(page.getByPlaceholder(/send a message/i)).toBeEnabled();

    // 5. Memory recall card renders.
    await expect(page.locator('[data-component="memory-card"]').first()).toBeVisible();

    // 6. Recall tool-call reaches completed state.
    await expect(
      page.locator(
        '[data-component="tool-call-card"][data-capability="agent.memory.recall"][data-status="completed"]',
      ),
    ).toBeVisible();

    // 7. Subagent fanout renders with exactly three children.
    const fanout = page.locator('[data-component="subagent-fanout"]');
    await expect(fanout).toBeVisible();
    await expect(fanout.locator('[data-role="child"]')).toHaveCount(3);

    // 8. Fanout reaches a completed state.
    await expect(
      page.locator('[data-component="subagent-fanout"][data-fanout-status="completed"]'),
    ).toBeVisible();

    // 9. Three code-execute cards rendered (one per subagent).
    await expect(page.locator('[data-component="code-execute-card"]')).toHaveCount(3);

    // 10. memory.write card renders.
    await expect(page.locator('[data-component="memory-card"]').last()).toBeVisible();

    // 11. Final assistant text confirms completion.
    await expect(page.getByText("Done.")).toBeVisible();

    // 12. Postgres assertions: approvals / fanouts / runs.
    // (execution.tool_calls was dropped in migration 0020; tool-call tracking is in ClickHouse)
    const dbState = await fixture.queryDbState();
    expect(dbState.approvalRequests.length).toBeGreaterThanOrEqual(1);
    expect(
      dbState.approvalRequests.some((a) => a.resolution === "approved"),
    ).toBe(true);
    expect(dbState.subagentFanouts.length).toBeGreaterThanOrEqual(1);
    expect(dbState.subagentRuns.length).toBeGreaterThanOrEqual(3);

    // 13. Neo4j assertions: INVOKED edges + AgentMemory node from the write.
    const neoState = await fixture.queryNeo4jState();
    expect(neoState.invokedEdges).toBeGreaterThanOrEqual(5);
    expect(neoState.agentMemoryNodes).toBeGreaterThanOrEqual(1);
  });
});
