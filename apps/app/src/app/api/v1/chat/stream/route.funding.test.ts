/**
 * route.funding.test.ts — who pays for a chat turn's tokens (ADR-053).
 *
 * The app chat route resolves the organisation's model funding source once
 * and hands the same answer to three places: the pre-turn credit gate (which
 * applies the assistant spend cap only to platform-funded turns), every
 * `selectModel` call (which builds the model on the organisation's own key
 * under org funding), and `runGovernedTurn` (which tells the ledger who paid).
 * These tests pin that wiring and its fallback — a resolver fault answers as
 * the platform key and the turn still runs — without a model, a database or
 * Postgres. Everything else the route does is covered by its sibling tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionOrRedirect: vi.fn(),
  resolveOrg: vi.fn(),
  resolveWorkspace: vi.fn(),
  assertOrgMember: vi.fn(),
  assertWorkspaceMember: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  selectModel: vi.fn(),
  loadEffectiveModelDefaults: vi.fn(),
  loadWorkspacePromptConfig: vi.fn(),
  resolveModelFundingSource: vi.fn(),
  materializeTools: vi.fn(),
  runGovernedTurn: vi.fn(),
  buildChatSystemPrompt: vi.fn(),
  createApprovalRequest: vi.fn(),
  waitForApproval: vi.fn(),
  withTenantDb: vi.fn(),
  invoke: vi.fn(),
  evaluateTurnCreditGate: vi.fn(),
  createTurnBudgetGuard: vi.fn(),
  budgetPolicyReadHandler: vi.fn(),
  recallWorkspaceMemoryDetailed: vi.fn(),
  resolveGroundingCitations: vi.fn(),
  translateAgentStream: vi.fn(),
  createTurnTranslator: vi.fn(),
  emitUsageEvent: vi.fn(),
  generateTurnSuggestions: vi.fn(),
  autoTitleConversation: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mocks.getSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mocks.resolveOrg,
  resolveWorkspace: mocks.resolveWorkspace,
  assertOrgMember: mocks.assertOrgMember,
  assertWorkspaceMember: mocks.assertWorkspaceMember,
}));
vi.mock("@oxagen/handlers/logger", () => ({ logger: mocks.logger }));
vi.mock("@oxagen/ai", () => ({
  selectModel: mocks.selectModel,
  supportsReasoning: () => false,
  supportsVision: () => true,
  supportsVideoInput: () => true,
  modelIdOf: (m: unknown) => (m as { modelId: string }).modelId,
  loadEffectiveModelDefaults: mocks.loadEffectiveModelDefaults,
  loadWorkspacePromptConfig: mocks.loadWorkspacePromptConfig,
  resolvePrompt: (a: { baseline: string }) => a.baseline,
  resolveModelFundingSource: mocks.resolveModelFundingSource,
  PLATFORM_FUNDING: { fundedBy: "platform" },
}));
vi.mock("@oxagen/ai/mentions", () => ({ parseMentions: () => [] }));
vi.mock("@oxagen/agent", () => ({
  materializeTools: mocks.materializeTools,
  runGovernedTurn: mocks.runGovernedTurn,
  buildChatSystemPrompt: mocks.buildChatSystemPrompt,
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));
// Side-effect registrations bind handlers into the real kernel; nothing here
// dispatches through it.
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: {
    messages: {},
    conversations: {},
  },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: <T>(_s: unknown, fn: () => Promise<T> | T) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mocks.invoke }));
vi.mock("@oxagen/oxagen/contracts/chat.message.send", () => ({
  CHAT_CONTENT_MAX_CHARS: 32_000,
}));
vi.mock("@oxagen/billing", async () => {
  const { z } = await import("zod");
  return {
    evaluateTurnCreditGate: mocks.evaluateTurnCreditGate,
    createTurnBudgetGuard: mocks.createTurnBudgetGuard,
    formatBudgetUsd: (n: number) => `$${n}`,
    governedBudgetFromRead: () => null,
    requestTurnBudgetSchema: z.object({}).passthrough(),
    resolveEffectiveTurnBudget: (p: unknown) => p,
    resolveTurnBudgetPolicy: (p: unknown) => p,
    turnBudgetPolicyFromSaved: (p: unknown) => p,
    TURN_BUDGET_OFF: { enabled: false, limitUsd: 0 },
  };
});
vi.mock("@oxagen/handlers/budget.policy.read", () => ({
  budgetPolicyReadHandler: mocks.budgetPolicyReadHandler,
}));
vi.mock("./recall-context", () => ({
  recallWorkspaceMemoryDetailed: mocks.recallWorkspaceMemoryDetailed,
  resolveGroundingCitations: mocks.resolveGroundingCitations,
}));
vi.mock("./attachments", () => ({
  resolveAttachmentImages: vi.fn(),
  resolveAttachmentMediaDetailed: vi.fn(),
}));
vi.mock("./apply-agent-binding", () => ({ applyAgentBinding: vi.fn() }));
vi.mock("./translate-stream", () => ({
  translateAgentStream: mocks.translateAgentStream,
  createTurnTranslator: mocks.createTurnTranslator,
  emitUsageEvent: mocks.emitUsageEvent,
}));
vi.mock("./suggest-prompts", () => ({
  buildRecentTurns: () => [],
  extractToolActivity: () => [],
  generateTurnSuggestions: mocks.generateTurnSuggestions,
}));
vi.mock("./auto-title", () => ({
  autoTitleConversation: mocks.autoTitleConversation,
}));

const { POST } = await import("./route");

const SESSION = { user: { id: "33333333-3333-3333-3333-333333333333" } };
const ORG = {
  id: "11111111-1111-1111-1111-111111111111",
  publicId: "org_pub",
  name: "Acme",
  slug: "acme",
};
const WORKSPACE = {
  id: "22222222-2222-2222-2222-222222222222",
  publicId: "ws_pub",
  orgId: ORG.id,
  name: "Main",
  slug: "main",
  description: "",
};

/** An organisation's own key, as `resolveModelFundingSource` answers it. */
const ORG_CREDENTIAL = {
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-THE-SECRET-KEY",
  digest: "d1g3st",
};
const ORG_FUNDING = {
  fundedBy: "org" as const,
  credential: ORG_CREDENTIAL,
  keyHint: "sk-or-…-KEY",
};

function governedTurn() {
  return {
    fullStream: (async function* () {})(),
    finalText: Promise.resolve(""),
    usage: Promise.resolve({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
    }),
    modelId: "anthropic/claude-sonnet-5",
    fundedBy: "platform" as const,
    budgeted: false,
    maxSteps: 12,
  };
}

/** POST a chat body at the route and drain the SSE response. */
async function postAndDrain(): Promise<Response> {
  const req = new Request("https://app.oxagen.sh/api/v1/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "how many runs?",
      orgSlug: ORG.slug,
      workspaceSlug: WORKSPACE.slug,
    }),
  });
  const res = await POST(req as unknown as NextRequest);
  // The turn runs inside the ReadableStream's start(); a test that asserts on
  // what the turn did must read the body to completion first.
  await res.text();
  return res;
}

function turnInput(): Record<string, unknown> {
  return mocks.runGovernedTurn.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionOrRedirect.mockResolvedValue(SESSION);
  mocks.resolveOrg.mockResolvedValue(ORG);
  mocks.resolveWorkspace.mockResolvedValue(WORKSPACE);
  mocks.assertOrgMember.mockResolvedValue(undefined);
  mocks.assertWorkspaceMember.mockResolvedValue(undefined);
  mocks.selectModel.mockReturnValue({ modelId: "anthropic/claude-sonnet-5" });
  // No picker selection and no saved default: the route calls selectModel
  // with only the funding-derived fields, which is what the tests read.
  mocks.loadEffectiveModelDefaults.mockResolvedValue({
    text: { model: null, tier: null },
  });
  mocks.loadWorkspacePromptConfig.mockResolvedValue({});
  mocks.resolveModelFundingSource.mockResolvedValue({ fundedBy: "platform" });
  mocks.evaluateTurnCreditGate.mockResolvedValue({ ok: true });
  mocks.materializeTools.mockResolvedValue({
    tools: { list_executions: {} },
    nameMap: { list_executions: "list_executions" },
    mutatingToolNames: [],
  });
  mocks.buildChatSystemPrompt.mockReturnValue("GOVERNANCE PROMPT");
  mocks.recallWorkspaceMemoryDetailed.mockResolvedValue({
    message: null,
    memories: [],
  });
  mocks.resolveGroundingCitations.mockResolvedValue([]);
  mocks.budgetPolicyReadHandler.mockResolvedValue({ enabled: false });
  mocks.invoke.mockResolvedValue({});
  mocks.createTurnBudgetGuard.mockReturnValue(undefined);
  mocks.createTurnTranslator.mockReturnValue({
    onPart: vi.fn(),
    finish: () => ({ assistantText: "", persistedBlocks: [] }),
  });
  mocks.translateAgentStream.mockResolvedValue({
    assistantText: "42 runs",
    persistedBlocks: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  });
  mocks.generateTurnSuggestions.mockResolvedValue(null);
  // No conversationId in these tests ⇒ no history read, no persistence.
  mocks.withTenantDb.mockImplementation(async () => []);
  mocks.runGovernedTurn.mockResolvedValue(governedTurn());
});

describe("POST /api/v1/chat/stream — who pays for the tokens (ADR-053)", () => {
  it("with a stored key: the gate hears org funding, the model is built on the key, the turn is org-funded", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue(ORG_FUNDING);

    const res = await postAndDrain();

    expect(res.status).toBe(200);
    expect(mocks.resolveModelFundingSource).toHaveBeenCalledWith(ORG.id);
    expect(mocks.evaluateTurnCreditGate).toHaveBeenCalledWith(ORG.id, {
      fundedBy: "org",
    });
    expect(mocks.selectModel).toHaveBeenCalledTimes(1);
    expect(mocks.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({ credential: ORG_CREDENTIAL }),
    );
    expect(turnInput()["fundedBy"]).toBe("org");
  });

  it("resolves funding BEFORE the gate decides, so the cap can be scoped to platform-funded turns", async () => {
    const order: string[] = [];
    mocks.resolveModelFundingSource.mockImplementation(async () => {
      order.push("funding");
      return ORG_FUNDING;
    });
    mocks.evaluateTurnCreditGate.mockImplementation(async () => {
      order.push("gate");
      return { ok: true };
    });

    await postAndDrain();

    expect(order).toEqual(["funding", "gate"]);
  });

  it("with no stored key: platform funding, and no credential reaches selectModel", async () => {
    await postAndDrain();

    expect(mocks.evaluateTurnCreditGate).toHaveBeenCalledWith(ORG.id, {
      fundedBy: "platform",
    });
    expect(mocks.selectModel).toHaveBeenCalledTimes(1);
    expect(mocks.selectModel.mock.calls[0]![0]).not.toHaveProperty(
      "credential",
    );
    expect(turnInput()["fundedBy"]).toBe("platform");
  });

  it("a failed funding read fails the turn before the gate, the model or the loop", async () => {
    // Never answered as "platform": that would move an organisation with its
    // own key onto Oxagen's billed key for the length of a database outage.
    // The rejection leaves POST uncaught, which Next answers as a 500.
    mocks.resolveModelFundingSource.mockRejectedValue(new Error("db down"));

    const req = new Request("https://app.oxagen.sh/api/v1/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "how many runs?",
        orgSlug: ORG.slug,
        workspaceSlug: WORKSPACE.slug,
      }),
    });

    await expect(POST(req as unknown as NextRequest)).rejects.toThrow(
      "db down",
    );
    expect(mocks.evaluateTurnCreditGate).not.toHaveBeenCalled();
    expect(mocks.selectModel).not.toHaveBeenCalled();
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  it("answers 402 naming the cap when a platform-funded org is over its assistant spend cap", async () => {
    mocks.evaluateTurnCreditGate.mockResolvedValue({
      ok: false,
      code: "assistant_spend_cap",
      message: "Assistant spend cap of $20.00 reached",
    });

    const res = await postAndDrain();

    expect(res.status).toBe(402);
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
    expect(mocks.selectModel).not.toHaveBeenCalled();
  });

  it("logs the key hint for an org-funded turn and never the key", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue(ORG_FUNDING);

    await postAndDrain();

    const modelLog = mocks.logger.info.mock.calls.find(
      (c) => c[1] === "[chat/stream] turn model",
    );
    expect(modelLog?.[0]).toMatchObject({
      fundedBy: "org",
      keyHint: ORG_FUNDING.keyHint,
    });
    const everyLogCall = [
      ...mocks.logger.info.mock.calls,
      ...mocks.logger.warn.mock.calls,
      ...mocks.logger.error.mock.calls,
    ];
    expect(JSON.stringify(everyLogCall)).not.toContain(ORG_CREDENTIAL.apiKey);
  });
});
