/**
 * chat.stream.test.ts
 *
 * The REST chat surface is a THIN adapter over `runGovernedTurn`
 * (@oxagen/agent). These tests lock in the adapter's contract — the published
 * ingress, the pre-turn credit gate, and that the turn reaches the governed
 * loop with the materialised tools, the governance system prompt and a stream
 * that is translated to this surface's SSE wire format — without ever touching
 * a model, a database or Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
  materializeTools: vi.fn(),
  runGovernedTurn: vi.fn(),
  buildChatSystemPrompt: vi.fn(),
  createApprovalRequest: vi.fn(),
  waitForApproval: vi.fn(),
  evaluateTurnCreditGate: vi.fn(),
  createTurnBudgetGuard: vi.fn(),
  withTenantDb: vi.fn(),
  budgetPolicyReadHandler: vi.fn(),
  recallWorkspaceMemoryMessage: vi.fn(),
  loadWorkspacePromptConfigSafe: vi.fn(),
  loadEffectiveModelDefaults: vi.fn(),
  selectModel: vi.fn(),
  resolveModelFundingSource: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));
vi.mock("@oxagen/agent", () => ({
  materializeTools: mocks.materializeTools,
  runGovernedTurn: mocks.runGovernedTurn,
  buildChatSystemPrompt: mocks.buildChatSystemPrompt,
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));
vi.mock("@oxagen/ai", () => ({
  selectModel: mocks.selectModel,
  modelIdOf: (m: unknown) => (m as { modelId: string }).modelId,
  supportsReasoning: () => true,
  resolvePrompt: (a: { baseline: string }) => a.baseline,
  loadWorkspacePromptConfigSafe: mocks.loadWorkspacePromptConfigSafe,
  loadEffectiveModelDefaults: mocks.loadEffectiveModelDefaults,
  resolveModelFundingSource: mocks.resolveModelFundingSource,
  PLATFORM_FUNDING: { fundedBy: "platform" },
}));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: {
    messages: {
      role: "role",
      content: "content",
      conversationId: "conversationId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      createdAt: "createdAt",
    },
    agents: {
      id: "id",
      activeVersionId: "activeVersionId",
      workspaceId: "workspaceId",
      slug: "slug",
    },
    conversations: { id: "id" },
    organizations: { id: "id", name: "name" },
    workspaces: { id: "id", name: "name" },
  },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: <T>(_s: unknown, fn: () => Promise<T> | T) => fn(),
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
vi.mock("./chat-memory", () => ({
  recallWorkspaceMemoryMessage: mocks.recallWorkspaceMemoryMessage,
}));

const { Hono } = await import("hono");
const { chatStreamRoute } = await import("./chat.stream");

// Mount exactly as apps/api does, so `org_slug` / `workspace_slug` resolve the
// same way the real surface resolves them.
const app = new Hono();
app.route("/v1/:org_slug/:workspace_slug/chat/stream", chatStreamRoute);

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "33333333-3333-3333-3333-333333333333",
  apiKeyId: null,
  requestId: "44444444-4444-4444-4444-444444444444",
  surface: "api" as const,
  messageId: null,
  clientIp: null,
};

/** POST a body at the mounted route. */
async function post(body: unknown | string): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/v1/acme/main/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/**
 * Drain the SSE body. The route returns its Response as soon as the stream is
 * constructed — the turn runs inside `start()` — so a test that asserts on what
 * the turn did MUST read the body to completion first.
 */
async function drain(res: Response): Promise<string> {
  return res.text();
}

/** Drain and decode the JSON `data:` payloads (the `[DONE]` sentinel is not one). */
async function readSse(res: Response): Promise<Array<{ type: string }>> {
  const text = await drain(res);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { type: string });
}

function governedTurn(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    finalText: Promise.resolve(""),
    usage: Promise.resolve({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cachedInputTokens: 0,
    }),
    modelId: "anthropic/claude-sonnet-5",
    budgeted: false,
    maxSteps: 12,
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(CTX);
  mocks.selectModel.mockReturnValue({ modelId: "anthropic/claude-sonnet-5" });
  mocks.resolveModelFundingSource.mockResolvedValue({ fundedBy: "platform" });
  mocks.evaluateTurnCreditGate.mockResolvedValue({ ok: true });
  mocks.materializeTools.mockResolvedValue({
    tools: { list_executions: {} },
    nameMap: { list_executions: "list_executions" },
    mutatingToolNames: [],
  });
  mocks.loadWorkspacePromptConfigSafe.mockResolvedValue({});
  mocks.recallWorkspaceMemoryMessage.mockResolvedValue(null);
  mocks.budgetPolicyReadHandler.mockResolvedValue({ enabled: false });
  mocks.invoke.mockResolvedValue({});
  mocks.createTurnBudgetGuard.mockReturnValue(undefined);
  mocks.buildChatSystemPrompt.mockReturnValue("GOVERNANCE PROMPT");
  // No conversationId in these tests ⇒ no history / persistence reads.
  mocks.withTenantDb.mockImplementation(async () => []);
  mocks.runGovernedTurn.mockResolvedValue(governedTurn([]));
});

describe("POST chat/stream — ingress", () => {
  it("rejects a malformed JSON body with 400", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  it("rejects an empty message with 400 and never opens a turn", async () => {
    const res = await post({ content: "" });
    expect(res.status).toBe(400);
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  it("rejects a message over the shared ingress cap with 400", async () => {
    const res = await post({ content: "x".repeat(200_000) });
    expect(res.status).toBe(400);
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });
});

describe("POST chat/stream — credit admission gate", () => {
  it("answers 402 and never calls the model when the org is out of credits", async () => {
    mocks.evaluateTurnCreditGate.mockResolvedValue({
      ok: false,
      code: "insufficient_credits",
      message: "Insufficient credits",
    });

    const res = await post({ content: "how much did we spend?" });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: { code: "insufficient_credits", message: "Insufficient credits" },
    });
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
    expect(mocks.materializeTools).not.toHaveBeenCalled();
  });

  it("answers 402 for a suspended org", async () => {
    mocks.evaluateTurnCreditGate.mockResolvedValue({
      ok: false,
      code: "billing_suspended",
      message: "Billing suspended",
    });
    const res = await post({ content: "hi" });
    expect(res.status).toBe(402);
  });

  it("answers 402 naming the cap when a platform-funded org is over its assistant spend cap", async () => {
    mocks.evaluateTurnCreditGate.mockResolvedValue({
      ok: false,
      code: "assistant_spend_cap",
      message: "Assistant spend cap of $20.00 reached",
    });
    const res = await post({ content: "hi" });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        code: "assistant_spend_cap",
        message: "Assistant spend cap of $20.00 reached",
      },
    });
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });
});

describe("POST chat/stream — who pays for the tokens (ADR-053)", () => {
  it("with a stored key: the gate hears org funding, the model is built on the key, the turn is org-funded", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue(ORG_FUNDING);

    await drain(await post({ content: "hi" }));

    expect(mocks.resolveModelFundingSource).toHaveBeenCalledWith(CTX.orgId);
    expect(mocks.evaluateTurnCreditGate).toHaveBeenCalledWith(CTX.orgId, {
      fundedBy: "org",
    });
    expect(mocks.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({ credential: ORG_CREDENTIAL }),
    );
    const input = mocks.runGovernedTurn.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input["fundedBy"]).toBe("org");
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

    await drain(await post({ content: "hi" }));

    expect(order).toEqual(["funding", "gate"]);
  });

  it("with no stored key: platform funding, and no credential reaches selectModel", async () => {
    await drain(await post({ content: "hi" }));

    expect(mocks.evaluateTurnCreditGate).toHaveBeenCalledWith(CTX.orgId, {
      fundedBy: "platform",
    });
    expect(mocks.selectModel).toHaveBeenCalledTimes(1);
    expect(mocks.selectModel.mock.calls[0]![0]).not.toHaveProperty(
      "credential",
    );
    const input = mocks.runGovernedTurn.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input["fundedBy"]).toBe("platform");
  });

  it("a failed funding read fails the turn before the gate, the model or the loop", async () => {
    // Never answered as "platform": that would move an organisation with its
    // own key onto Oxagen's billed key for the length of a database outage.
    // Hono's default handler answers the throw with a 500 here; the real app
    // routes it through errorMiddleware (apps/api/src/app.ts).
    mocks.resolveModelFundingSource.mockRejectedValue(new Error("db down"));

    const res = await post({ content: "hi" });

    expect(res.status).toBe(500);
    expect(mocks.evaluateTurnCreditGate).not.toHaveBeenCalled();
    expect(mocks.selectModel).not.toHaveBeenCalled();
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  it("logs the key hint for an org-funded turn and never the key", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue(ORG_FUNDING);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await drain(await post({ content: "hi" }));

    const modelLog = info.mock.calls.find(
      (c) => c[0] === "[chat.stream] turn model",
    );
    expect(modelLog?.[1]).toMatchObject({
      fundedBy: "org",
      keyHint: ORG_FUNDING.keyHint,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      ORG_CREDENTIAL.apiKey,
    );
    info.mockRestore();
  });
});

describe("POST chat/stream — the governed turn", () => {
  it("streams SSE and terminates with the [DONE] sentinel", async () => {
    mocks.runGovernedTurn.mockResolvedValue(
      governedTurn([{ type: "text-delta", text: "42 runs" }]),
    );

    const res = await post({ content: "how many runs?" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain('data: {"type":"text","text":"42 runs"}');
    expect(body.trimEnd().endsWith("event: done\ndata: [DONE]")).toBe(true);
  });

  it("hands runGovernedTurn the materialised tools and the governance prompt", async () => {
    await drain(await post({ content: "what is pending approval?" }));

    expect(mocks.runGovernedTurn).toHaveBeenCalledTimes(1);
    const input = mocks.runGovernedTurn.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(input["tools"] as object)).toEqual(["list_executions"]);
    expect(input["system"]).toBe("GOVERNANCE PROMPT");
    expect(input["instruction"]).toBe("what is pending approval?");
    expect(input["telemetry"]).toEqual({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      surface: "api",
      messageId: CTX.requestId,
    });
  });

  it("names the URL scope in the system prompt it builds", async () => {
    await drain(await post({ content: "hi" }));
    expect(mocks.buildChatSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "acme", workspaceSlug: "main" }),
    );
  });

  it("injects recalled workspace memory as a per-turn context message", async () => {
    mocks.recallWorkspaceMemoryMessage.mockResolvedValue({
      role: "user",
      content: "## Recalled workspace memory",
    });

    await drain(await post({ content: "what did we learn?" }));

    const input = mocks.runGovernedTurn.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input["contextMessages"]).toEqual([
      { role: "user", content: "## Recalled workspace memory" },
    ]);
  });

  it("emits ONE aggregated usage event from the turn's own totals", async () => {
    const events = (await readSse(await post({ content: "hi" }))) as Array<{
      type: string;
      usage?: unknown;
    }>;
    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });

  it("surfaces a turn failure as a typed error event, still terminating the stream", async () => {
    mocks.runGovernedTurn.mockRejectedValue(new Error("gateway unreachable"));

    const res = await post({ content: "hi" });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('"type":"error"');
    expect(body).toContain("gateway unreachable");
    expect(body).toContain("[DONE]");
  });

  it("forwards a per-turn budget guard only when one is configured", async () => {
    await drain(await post({ content: "hi" }));
    expect(
      mocks.runGovernedTurn.mock.calls[0]![0] as Record<string, unknown>,
    ).not.toHaveProperty("budgetGuard");

    const guard = vi.fn();
    mocks.createTurnBudgetGuard.mockReturnValue(guard);
    await drain(await post({ content: "hi" }));
    expect(
      (mocks.runGovernedTurn.mock.calls[1]![0] as Record<string, unknown>)[
        "budgetGuard"
      ],
    ).toBe(guard);
  });
});
