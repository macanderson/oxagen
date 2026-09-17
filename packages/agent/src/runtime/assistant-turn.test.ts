/**
 * The in-app agent's turn: the order its gates run in, what it writes and
 * when, what the engine loop is handed, and what it refuses. Every seam is a
 * fake; the loop itself is covered by governed-turn.test.ts and the recorder
 * by assistant-run.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  apiKeyCreator: vi.fn((): string | null => null),
  resolveModelFundingSource: vi.fn(),
  evaluateTurnCreditGate: vi.fn(),
  createTurnBudgetGuard: vi.fn(),
  loadEffectiveModelDefaults: vi.fn(),
  withTenantDb: vi.fn(),
  invoke: vi.fn(),
  materializeTools: vi.fn(),
  runGovernedTurn: vi.fn(),
  openAssistantRun: vi.fn(),
  recall: vi.fn(),
  createApprovalRequest: vi.fn(),
  waitForApproval: vi.fn(),
  assertOrgRole: vi.fn(),
  log: [] as string[],
}));

vi.mock("@oxagen/ai", () => ({
  tool: (def: unknown) => def,
  resolveModelFundingSource: mocks.resolveModelFundingSource,
  loadEffectiveModelDefaults: mocks.loadEffectiveModelDefaults,
  loadWorkspacePromptConfigSafe: async () => ({}),
  resolvePrompt: (a: { baseline: string }) => a.baseline,
  selectModel: (s: { model?: string; tier?: string }) => ({
    modelId: s.model ?? `model-for-${s.tier ?? "default"}`,
  }),
  modelIdOf: (m: { modelId: string }) => m.modelId,
  supportsReasoning: () => true,
}));
vi.mock("@oxagen/billing", () => ({
  evaluateTurnCreditGate: mocks.evaluateTurnCreditGate,
  createTurnBudgetGuard: mocks.createTurnBudgetGuard,
  formatBudgetUsd: (n: number) => `$${n}`,
  governedBudgetFromRead: () => null,
  resolveEffectiveTurnBudget: (p: unknown) => p,
  resolveTurnBudgetPolicy: (p: unknown) => p,
  turnBudgetPolicyFromSaved: (p: unknown) => p,
  TURN_BUDGET_OFF: { enabled: false, limitUsd: 0 },
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
// resolveActingUserId is org-role.ts's own key-to-creator read; the fake
// answers the session user, else the creator the world's API key row names.
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: async (ctx: {
    userId: string | null;
    apiKeyId: string | null;
  }) => ctx.userId ?? (ctx.apiKeyId ? mocks.apiKeyCreator() : null),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../system-prompt", () => ({
  buildChatSystemPrompt: (a: { orgName: string; workspaceName: string }) =>
    `GOVERNANCE ${a.orgName}/${a.workspaceName}`,
}));
vi.mock("./approval", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));
vi.mock("./assistant-recall", () => ({
  recallWorkspaceMemoryMessage: mocks.recall,
}));
vi.mock("./assistant-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./assistant-run")>();
  return { ...real, openAssistantRun: mocks.openAssistantRun };
});
vi.mock("./materialize-tools", async (importOriginal) => {
  const real = await importOriginal<typeof import("./materialize-tools")>();
  return { ...real, materializeTools: mocks.materializeTools };
});
vi.mock("./governed-turn", async (importOriginal) => {
  const real = await importOriginal<typeof import("./governed-turn")>();
  return { ...real, runGovernedTurn: mocks.runGovernedTurn };
});

import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  AssistantTurnNeedsUserError,
  AssistantTurnRefusedError,
  ConversationNotFoundError,
  prepareAssistantTurn,
  type AssistantTurnHooks,
} from "./assistant-turn";
import { LOAD_TOOLS, SEARCH_TOOLS } from "./tool-belt";

const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};
const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const AGENT_ID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const AGENT_VERSION_ID = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const EXECUTION_ID = "0192d4a8-7c1e-7a00-8000-0000000000e1";

interface World {
  conversationExists: boolean;
  history: Array<{ role: string; content: string }>;
  apiKeyCreator: string | null;
}
interface Captured {
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
}

function makeTx(world: World, captured: Captured) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => {
            if (table === schema.conversations)
              return Promise.resolve(
                world.conversationExists ? [{ id: CONVERSATION }] : [],
              );
            if (table === schema.messages)
              return Promise.resolve([...world.history].reverse());
            if (table === schema.organizations)
              return Promise.resolve([{ name: "Acme" }]);
            if (table === schema.workspaces)
              return Promise.resolve([{ name: "Core" }]);
            throw new Error("unexpected table");
          },
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push({ table, values });
        mocks.log.push(
          table === schema.conversations
            ? "insert:conversation"
            : `insert:message:${String(values.role)}`,
        );
        return {
          returning: () =>
            Promise.resolve([
              {
                id:
                  table === schema.conversations
                    ? CONVERSATION
                    : `msg-${String(values.role)}`,
              },
            ]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        captured.updates.push({ table, set });
        return { where: () => Promise.resolve() };
      },
    }),
  };
}

/** Prepare and run, as the handler does. */
async function runTurn(
  req: Parameters<typeof prepareAssistantTurn>[0],
  hooks?: AssistantTurnHooks,
) {
  const prepared = await prepareAssistantTurn(req);
  return prepared.run(hooks);
}

function fakeTurn(options: { parts?: unknown[]; text?: string; fail?: Error }) {
  const parts = options.parts ?? [{ type: "text-delta", text: "hi" }];
  // runGovernedTurn pre-catches its result promises so a caller that never
  // reads one sees no unhandled rejection; the fake keeps that contract.
  const failed = <T>(): Promise<T> => {
    const p = Promise.reject(options.fail);
    p.catch(() => undefined);
    return p;
  };
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
      if (options.fail) yield { type: "error", error: options.fail };
    })(),
    finalText: options.fail
      ? failed<string>()
      : Promise.resolve(options.text ?? "hi"),
    usage: options.fail
      ? failed<{
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedInputTokens: number;
        }>()
      : Promise.resolve({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 0,
        }),
    modelId: "m",
    fundedBy: "platform",
    budgeted: false,
    maxSteps: 12,
    turnId: Promise.resolve("turn-1"),
  };
}

let world: World;
let captured: Captured;

function setup(over: Partial<World> = {}) {
  world = {
    conversationExists: true,
    history: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "before" },
    ],
    apiKeyCreator: null,
    ...over,
  };
  captured = { inserts: [], updates: [] };
  mocks.log.length = 0;
  mocks.apiKeyCreator.mockImplementation(() => world.apiKeyCreator);
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(world, captured))),
  );
}

const GOVERNED_TOOLS = {
  recall_memory: {
    description: "Recall",
    inputSchema: {},
    execute: async () => 1,
  },
  set_budget: { description: "Set", inputSchema: {}, execute: async () => 2 },
};

/** Every outcome the run recorder was sealed with, per test. */
let sealCalls: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  mocks.assertOrgRole.mockImplementation(async () => {
    mocks.log.push("roles");
    return "Owner";
  });
  mocks.resolveModelFundingSource.mockImplementation(async () => {
    mocks.log.push("funding");
    return { fundedBy: "platform" };
  });
  mocks.evaluateTurnCreditGate.mockImplementation(async () => {
    mocks.log.push("gate");
    return { ok: true };
  });
  mocks.loadEffectiveModelDefaults.mockResolvedValue({
    text: { model: null, tier: "balanced" },
  });
  mocks.createTurnBudgetGuard.mockReturnValue(undefined);
  mocks.invoke.mockImplementation(async (name: string) =>
    name === "get_message_execution"
      ? {
          executionId: EXECUTION_ID,
          status: "completed",
          createdAt: new Date(),
        }
      : {
          enabled: false,
          limitUsd: null,
          mode: "grace",
          graceOveragePct: 0.25,
        },
  );
  mocks.recall.mockResolvedValue({ role: "user", content: "[memory]" });
  mocks.materializeTools.mockImplementation(async () => {
    mocks.log.push("materialize");
    return {
      tools: GOVERNED_TOOLS,
      nameMap: { recall_memory: "recall_memory", set_budget: "set_budget" },
      mutatingToolNames: ["set_budget"],
      governance: {},
    };
  });
  sealCalls = [];
  mocks.openAssistantRun.mockImplementation(async () => {
    mocks.log.push("open-run");
    const receipts: unknown[] = [];
    return {
      runId: "run-uuid",
      runPublicId: "arun_0123456789abcdef012345",
      agentId: AGENT_ID,
      agentVersionId: AGENT_VERSION_ID,
      receipts,
      modelCall: async (r: unknown) => {
        receipts.push({ kind: "model", ...(r as object) });
      },
      toolCall: async (r: unknown) => {
        receipts.push({ kind: "tool", ...(r as object) });
      },
      seal: async (outcome: unknown) => {
        sealCalls.push(outcome);
      },
    };
  });
  mocks.runGovernedTurn.mockImplementation(async () => {
    mocks.log.push("engine");
    return fakeTurn({});
  });
});

const request = {
  ctx: CTX,
  surface: "chat" as const,
  orgSlug: "acme",
  workspaceSlug: "core",
  conversationId: CONVERSATION,
  content: "explain this run",
  pageContext: {
    route: "run",
    orgSlug: "acme",
    workspaceSlug: "core",
    entityId: "arun_x",
  },
};

describe("prepareAssistantTurn", () => {
  it("resolves funding before the gate and refuses with the gate's code before anything is written", async () => {
    mocks.evaluateTurnCreditGate.mockImplementationOnce(async () => {
      mocks.log.push("gate");
      return { ok: false, code: "insufficient_credits", message: "empty" };
    });
    await expect(prepareAssistantTurn(request)).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantTurnRefusedError &&
        e.code === "insufficient_credits",
    );
    expect(mocks.log).toEqual(["roles", "funding", "gate"]);
    expect(mocks.evaluateTurnCreditGate).toHaveBeenCalledWith("org-1", {
      fundedBy: "platform",
    });
    expect(captured.inserts).toHaveLength(0);
    expect(mocks.openAssistantRun).not.toHaveBeenCalled();
  });

  it("checks the contract's roles for the person before funding, and refuses a role it does not grant (negative)", async () => {
    await prepareAssistantTurn(request);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", userId: "user-1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );

    mocks.log.length = 0;
    mocks.assertOrgRole.mockRejectedValueOnce(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(prepareAssistantTurn(request)).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.reason === "org_role_required",
    );
    expect(mocks.log).toEqual([]);
    expect(mocks.resolveModelFundingSource).toHaveBeenCalledTimes(1);
    expect(captured.inserts).toHaveLength(0);
  });

  it("lets an API key ask as the person who created it, and refuses a key with no creator (negative)", async () => {
    setup({ apiKeyCreator: "creator-1" });
    const prepared = await prepareAssistantTurn({
      ...request,
      ctx: { ...CTX, userId: null, apiKeyId: "aky-1" },
    });
    const result = await prepared.run();
    expect(result.runId).toBe("arun_0123456789abcdef012345");
    expect(mocks.openAssistantRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "creator-1" }),
    );
    expect(
      captured.inserts.find((i) => i.table === schema.messages)!.values,
    ).toMatchObject({ createdByUserId: "creator-1" });

    setup({ apiKeyCreator: null });
    await expect(
      prepareAssistantTurn({
        ...request,
        ctx: { ...CTX, userId: null, apiKeyId: "aky-1" },
      }),
    ).rejects.toBeInstanceOf(AssistantTurnNeedsUserError);
  });
});

describe("the prepared turn", () => {
  it("writes the question, admits the run, then drives the engine on the belt with the run as its ledger", async () => {
    const parts: unknown[] = [];
    const runs: string[] = [];
    const usages: unknown[] = [];
    const result = await runTurn(request, {
      onPart: (p) => parts.push(p),
      onRun: (r) => runs.push(r.runId),
      onUsage: (u) => usages.push(u),
    });
    expect(mocks.log).toEqual([
      "roles",
      "funding",
      "gate",
      "insert:message:user",
      "materialize",
      "open-run",
      "engine",
      "insert:message:assistant",
    ]);
    expect(runs).toEqual(["arun_0123456789abcdef012345"]);
    expect(parts).toEqual([{ type: "text-delta", text: "hi" }]);
    expect(result).toEqual({
      conversationId: CONVERSATION,
      userMessageId: "msg-user",
      assistantMessageId: "msg-assistant",
      runId: "arun_0123456789abcdef012345",
      reply: "hi",
      parkedCards: [],
    });
    expect(usages).toEqual([
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 0,
      },
    ]);

    // Tools are materialised in park mode for the person's own context, under
    // the persisted user message's id: an approval a tool call parks carries
    // it, and resolve_approval follows it back to the person who asked.
    const [materializeCtx, materializeOpts] =
      mocks.materializeTools.mock.calls[0]!;
    expect(materializeCtx).toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      messageId: "msg-user",
      executionStepId: "msg-user",
    });
    expect(materializeOpts).toMatchObject({ approvalMode: "park" });
    // The belt owns `search_tools` and `load_tools` inside a turn. Their
    // capability contracts declare the same names, and `modelToolsFor` layers
    // the governed definition over the meta-tool for anything pinned or
    // loaded — the model would be shown the contract's schema while the
    // meta-tool executes, with different required fields and a different
    // output shape.
    expect([...(materializeOpts.excludeCapabilities ?? [])].sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS].sort(),
    );

    // The run is admitted for this turn's goal on the app surface.
    expect(mocks.openAssistantRun).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      surface: "chat",
      instruction: "explain this run",
      maxSteps: 12,
      // The spec's tool policy is what the turn actually holds — the
      // materialised capabilities and the belt's two meta-tools. An empty
      // allowlist would read "no tools" on a run whose job is calling them.
      toolAllowlist: ["recall_memory", "set_budget", SEARCH_TOOLS, LOAD_TOOLS],
    });

    // The engine is declared the whole belt plus the meta-tools; the model is
    // shown the interactive agent's pinned capability and the meta-tools; the
    // run is the ledger; the page context and the memory ride as context.
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS, "recall_memory", "set_budget"].sort(),
    );
    expect(Object.keys(turnInput.modelTools()).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS, "recall_memory"].sort(),
    );
    expect(turnInput.ledger.runPublicId).toBe("arun_0123456789abcdef012345");
    expect(turnInput.principal).toBe("user-1");
    expect(turnInput.system).toBe("GOVERNANCE Acme/Core");
    expect(turnInput.history).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "before" },
    ]);
    expect(turnInput.contextMessages[0].content).toContain("run (arun_x)");
    expect(turnInput.contextMessages[1]).toEqual({
      role: "user",
      content: "[memory]",
    });
    expect(turnInput.telemetry).toEqual({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "app",
      messageId: "msg-user",
    });

    // The reply is persisted with the run it was recorded as, and the
    // conversation's active leaf moves to it.
    const assistantInsert = captured.inserts.find(
      (i) => i.table === schema.messages && i.values.role === "assistant",
    )!;
    expect(assistantInsert.values).toMatchObject({
      content: "hi",
      metadata: {
        status: "complete",
        surface: "chat",
        runId: "arun_0123456789abcdef012345",
      },
    });
    expect(captured.updates[0]!.set).toMatchObject({
      activeLeafMessageId: "msg-assistant",
    });
  });

  it("opens a conversation on a null id and refuses an unknown one before any write (negative)", async () => {
    await runTurn({ ...request, conversationId: null });
    expect(mocks.log.slice(0, 4)).toEqual([
      "roles",
      "funding",
      "gate",
      "insert:conversation",
    ]);

    setup({ conversationExists: false });
    mocks.openAssistantRun.mockClear();
    await expect(runTurn(request)).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
    expect(captured.inserts).toHaveLength(0);
    expect(mocks.openAssistantRun).not.toHaveBeenCalled();
  });

  it("returns a governed write the turn parked as the card, and never a budget pause", async () => {
    mocks.materializeTools.mockImplementationOnce(
      async (
        _ctx: unknown,
        opts: { onApprovalRequired: (e: unknown) => void },
      ) => {
        opts.onApprovalRequired({
          approvalId: "apr_1",
          capability: "set_budget",
          inputPreview: {},
          riskLevel: "high",
          expiresAt: "2026-09-14T10:05:00.000Z",
        });
        opts.onApprovalRequired({
          approvalId: "apr_2",
          capability: "budget.turn.continue",
          inputPreview: {},
          riskLevel: "low",
          expiresAt: "2026-09-14T10:06:00.000Z",
        });
        return {
          tools: GOVERNED_TOOLS,
          nameMap: {},
          mutatingToolNames: [],
          governance: {},
        };
      },
    );
    const events: unknown[] = [];
    const result = await runTurn(request, {
      onApprovalRequired: (e) => events.push(e),
    });
    expect(result.parkedCards).toEqual([
      {
        approvalId: "apr_1",
        capability: "set_budget",
        expiresAt: "2026-09-14T10:05:00.000Z",
      },
    ]);
    expect(events).toHaveLength(2);
  });

  it("does not persist a reply when the turn fails, and rejects with the failure", async () => {
    const failure = Object.assign(
      new Error("the assistant engine is unavailable"),
      {
        code: "engine_unavailable",
      },
    );
    mocks.runGovernedTurn.mockImplementationOnce(async () =>
      fakeTurn({ parts: [], fail: failure }),
    );
    const parts: unknown[] = [];
    await expect(
      runTurn(request, { onPart: (p) => parts.push(p) }),
    ).rejects.toBe(failure);
    expect(parts).toEqual([{ type: "error", error: failure }]);
    expect(
      captured.inserts
        .filter((i) => i.table === schema.messages)
        .map((i) => i.values.role),
    ).toEqual(["user"]);
  });

  it("does not save an aborted turn as a reply: the error part rejects the turn even when finalText resolves", async () => {
    const aborted = Object.assign(new Error("turn budget exhausted"), {
      code: "engine_aborted",
    });
    mocks.runGovernedTurn.mockImplementationOnce(async () => ({
      ...fakeTurn({ text: "partial" }),
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        yield { type: "error", error: aborted };
      })(),
    }));
    const usages: unknown[] = [];
    await expect(
      runTurn(request, { onUsage: (u) => usages.push(u) }),
    ).rejects.toBe(aborted);
    expect(usages).toEqual([]);
    expect(
      captured.inserts
        .filter((i) => i.table === schema.messages)
        .map((i) => i.values.role),
    ).toEqual(["user"]);
    expect(captured.updates).toHaveLength(0);
  });

  it("does not reach the engine when the ledger will not admit the run", async () => {
    mocks.openAssistantRun.mockRejectedValueOnce(new Error("ledger refused"));
    await expect(runTurn(request)).rejects.toThrow("ledger refused");
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  it("seals the admitted run as failed when the turn's preflight refuses", async () => {
    // openAssistantRun has already created the run and its attempt, and
    // runGovernedTurn installs no sealing path until after its preflight (the
    // engine readiness probe, the provider tool-count cap, the contract
    // conversion). A refusal in that window used to leave the run open for
    // ever, and an engine outage refuses every turn — so the record would
    // fill with unsealed runs exactly when it matters most.
    mocks.runGovernedTurn.mockRejectedValueOnce(
      new Error("engine is unavailable"),
    );
    await expect(runTurn(request)).rejects.toThrow("engine is unavailable");
    expect(sealCalls).toEqual([
      { status: "failed", error: "engine is unavailable" },
    ]);
  });

  it("seals once, not twice, when the turn itself runs (negative)", async () => {
    // runGovernedTurn seals on its own detached chain after it returns, so the
    // preflight guard must not add a second seal for a turn that got going.
    await runTurn(request);
    expect(sealCalls).toEqual([]);
  });

  // The agent-execution record (SOC 2 CC6/CC7) and, through its handler, the
  // Neo4j tool-usage lineage projection. `list_executions` and
  // `get_execution_trace` are in the assistant's own belt, so a turn that skips
  // this makes the assistant answer "nothing happened" about itself.
  describe("agent-execution record", () => {
    /** The receipts a two-completion, one-tool turn leaves on the recorder. */
    function turnWithReceipts() {
      mocks.runGovernedTurn.mockImplementationOnce(
        async (args: {
          ledger: {
            modelCall: (r: unknown) => Promise<void>;
            toolCall: (r: unknown) => Promise<void>;
          };
        }) => {
          await args.ledger.modelCall({
            seq: 1,
            requestId: "mc-1",
            role: "worker",
            provider: "anthropic",
            model: "claude",
            outcome: "completed",
            usage: { input_tokens: 7, output_tokens: 3 },
          });
          await args.ledger.toolCall({
            seq: 2,
            requestId: "tc-1",
            toolName: "recall_memory",
            outcome: "completed",
            input: { query: "runs" },
            output: { hits: 2 },
            durationMs: 12.6,
          });
          await args.ledger.modelCall({
            seq: 3,
            requestId: "mc-2",
            role: "worker",
            provider: "anthropic",
            model: "claude",
            outcome: "completed",
            usage: { input_tokens: 11, output_tokens: 4 },
          });
          return fakeTurn({});
        },
      );
    }

    function executionCall() {
      return mocks.invoke.mock.calls.find(
        (c: unknown[]) => c[0] === "get_message_execution",
      );
    }

    it("records the turn against the run's agent and the assistant message", async () => {
      await runTurn(request);
      const call = executionCall();
      expect(call, "no get_message_execution invoke").toBeDefined();
      expect(call![1]).toMatchObject({
        messageId: "msg-assistant",
        originId: "msg-assistant",
        originType: "chat",
        agentId: AGENT_ID,
        agentVersionId: AGENT_VERSION_ID,
        status: "completed",
        updateMessageMetadata: true,
        inputTokens: 10,
        outputTokens: 5,
      });
    });

    it("builds the steps from the ledger's receipts, tools under the completion that asked", async () => {
      turnWithReceipts();
      await runTurn(request);
      const input = executionCall()![1] as {
        steps: Array<{
          stepNumber: number;
          inputTokens?: number;
          toolCalls?: Array<Record<string, unknown>>;
        }>;
      };
      expect(input.steps).toHaveLength(2);
      expect(input.steps[0]).toMatchObject({
        stepNumber: 1,
        stepType: "llm_turn",
        status: "completed",
        inputTokens: 7,
        outputTokens: 3,
      });
      expect(input.steps[0]!.toolCalls).toEqual([
        {
          toolName: "recall_memory",
          toolType: "capability",
          requestPayload: { query: "runs" },
          responsePayload: { hits: 2 },
          status: "completed",
          latencyMs: 13,
        },
      ]);
      expect(input.steps[1]).toMatchObject({ stepNumber: 2, inputTokens: 11 });
      expect(input.steps[1]!.toolCalls).toEqual([]);
    });

    it("records a failed tool call as a failed step entry rather than dropping it (negative)", async () => {
      mocks.runGovernedTurn.mockImplementationOnce(
        async (args: {
          ledger: {
            modelCall: (r: unknown) => Promise<void>;
            toolCall: (r: unknown) => Promise<void>;
          };
        }) => {
          await args.ledger.modelCall({
            seq: 1,
            requestId: "mc-1",
            role: "worker",
            provider: "anthropic",
            model: "claude",
            outcome: "completed",
          });
          await args.ledger.toolCall({
            seq: 2,
            requestId: "tc-1",
            toolName: "set_budget",
            outcome: "denied",
            input: { usd: 5 },
            error: "not permitted",
            durationMs: 1,
          });
          return fakeTurn({});
        },
      );
      await runTurn(request);
      const input = executionCall()![1] as {
        steps: Array<{ toolCalls?: Array<Record<string, unknown>> }>;
      };
      expect(input.steps[0]!.toolCalls).toEqual([
        {
          toolName: "set_budget",
          toolType: "capability",
          requestPayload: { usd: 5 },
          responsePayload: { error: "not permitted" },
          status: "failed",
          latencyMs: 1,
        },
      ]);
    });

    // The reply is already persisted and, on the SSE route, already sent. A
    // missing audit record is a defect, so it is logged — but it must not take
    // the answer away from the person who already has it.
    it("still answers when the execution record cannot be written (negative)", async () => {
      mocks.invoke.mockImplementation(async (name: string) => {
        if (name === "get_message_execution")
          throw new Error("agent_executions write failed");
        return {
          enabled: false,
          limitUsd: null,
          mode: "grace",
          graceOveragePct: 0.25,
        };
      });
      const result = await runTurn(request);
      expect(result.reply).toBe("hi");
      expect(result.assistantMessageId).toBe("msg-assistant");
    });

    it("does not record an execution for a turn that never produced a reply (negative)", async () => {
      const failure = Object.assign(new Error("engine down"), {
        code: "engine_unavailable",
      });
      mocks.runGovernedTurn.mockImplementationOnce(async () =>
        fakeTurn({ fail: failure }),
      );
      await expect(runTurn(request)).rejects.toBe(failure);
      expect(executionCall()).toBeUndefined();
    });
  });
});
