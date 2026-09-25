/**
 * The in-app agent's turn: the order its gates run in, what it writes and
 * when, what the engine loop is handed, and what it refuses. Every seam is a
 * fake; the loop itself is covered by governed-turn.test.ts and the recorder
 * by assistant-run.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { digestJcs } from "@oxagen/run-evidence";
import { resourceScopeDigestOf } from "@oxagen/iam";
import { z } from "zod";

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
  readAssistantAgentState: vi.fn(),
  recall: vi.fn(),
  createApprovalRequest: vi.fn(),
  waitForApproval: vi.fn(),
  assertOrgRole: vi.fn(),
  promptConfig: vi.fn(),
  generateObjectFor: vi.fn(),
  publishedSteering: vi.fn(),
  steeringManifest: vi.fn(),
  // The catalog, as `supportsReasoning` reads it: keyed by gateway ids, so a
  // bare vendor spelling is an id it cannot describe and answers false for.
  supportsReasoning: vi.fn((id: string) => id.includes("/")),
  // The belt suite runs the real materializeTools over these two seams.
  readActiveEmergencyDenies: vi.fn(
    async (): Promise<
      readonly import("@oxagen/iam").ActiveEmergencyDeny[]
    > => [],
  ),
  registry: [] as unknown[],
  log: [] as string[],
}));

vi.mock("@oxagen/ai", () => ({
  tool: (def: unknown) => def,
  resolveModelFundingSource: mocks.resolveModelFundingSource,
  loadEffectiveModelDefaults: mocks.loadEffectiveModelDefaults,
  loadWorkspacePromptConfigSafe: async () => mocks.promptConfig(),
  selectModel: (s: Selector) => ({ modelId: wireIdFor(s) }),
  modelIdOf: (m: { modelId: string }) => m.modelId,
  // The real `modelIdentityFor`, in miniature: on a direct-vendor key the
  // request carries the key's own model id and the catalog id is that id
  // under the vendor's prefix. Everything else is already gateway-shaped.
  resolveModelIdentity: (s: Selector) => {
    const wireId = wireIdFor(s);
    const provider = s.credential?.provider ?? "anthropic";
    return {
      wireId,
      catalogId:
        provider === "openai" || provider === "anthropic"
          ? wireId.includes("/")
            ? wireId
            : `${provider}/${wireId}`
          : wireId,
      provider,
    };
  },
  supportsReasoning: (id: string) => mocks.supportsReasoning(id),
  // The summariser's seams (history-summary.ts): the model is built from the
  // funding source the turn resolved, exactly as `selectModel` builds it.
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: mocks.generateObjectFor,
  selectModelFromFunding: (
    _orgId: string,
    funding: { fundedBy: string; modelKey?: Selector["credential"] },
    s: Selector,
  ) => ({
    model: {
      modelId: wireIdFor({
        ...s,
        ...(funding.modelKey ? { credential: funding.modelKey } : {}),
      }),
    },
    fundedBy: funding.fundedBy,
  }),
}));

interface Selector {
  model?: string;
  tier?: string;
  credential?: {
    provider: string;
    modelMap?: Record<string, string | undefined>;
  };
}

/** What the endpoint is asked for: the key's own id when it has one. */
function wireIdFor(s: Selector): string {
  const tier = s.tier ?? "balanced";
  const mapped =
    s.credential?.modelMap?.[tier] ?? s.credential?.modelMap?.balanced;
  if (mapped) return mapped;
  return s.model ?? `model-for-${s.tier ?? "default"}`;
}
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
// The registry read only. The assembly is the real one, so a test sees the
// text and the manifest the turn would produce.
vi.mock("./published-steering", async (importOriginal) => {
  const real = await importOriginal<typeof import("./published-steering")>();
  return { ...real, readPublishedSteeringCandidates: mocks.publishedSteering };
});
vi.mock("./assistant-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./assistant-run")>();
  return {
    ...real,
    openAssistantRun: mocks.openAssistantRun,
    readAssistantAgentState: mocks.readAssistantAgentState,
  };
});
vi.mock("./materialize-tools", async (importOriginal) => {
  const real = await importOriginal<typeof import("./materialize-tools")>();
  return { ...real, materializeTools: mocks.materializeTools };
});
vi.mock("./governed-turn", async (importOriginal) => {
  const real = await importOriginal<typeof import("./governed-turn")>();
  return { ...real, runGovernedTurn: mocks.runGovernedTurn };
});
// The seams the real materializeTools reads when the belt suite calls it: the
// active emergency denies, the capability registry, and the plugin-type
// contributors (none here, so no MCP server is dialled).
vi.mock("@oxagen/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam")>();
  return {
    ...real,
    readActiveEmergencyDenies: mocks.readActiveEmergencyDenies,
  };
});
vi.mock("../registry-loader", async (importOriginal) => {
  const real = await importOriginal<typeof import("../registry-loader")>();
  return {
    ...real,
    getOxagenRegistry: async () => ({
      listCapabilities: () => mocks.registry,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }),
  };
});
vi.mock("./plugin-type", async (importOriginal) => {
  const real = await importOriginal<typeof import("./plugin-type")>();
  return { ...real, getPluginTypeContributors: () => [] };
});

import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  AssistantStoppedError,
  AssistantTurnNeedsUserError,
  AssistantTurnRefusedError,
  ConversationNotFoundError,
  prepareAssistantTurn,
  type AssistantTurnHooks,
} from "./assistant-turn";
import {
  ASSISTANT_STEERING_BUDGET_TOKENS,
  type AssistantSteeringFrame,
  WORKSPACE_INSTRUCTIONS_ID,
} from "./assistant-steering";
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
/** The workspace's assistant agent, as `readAssistantAgentState` answers. */
const ASSISTANT = {
  agentId: "agt_assistant",
  principalId: "prn_assistant",
  stoppedBy: null,
};

interface World {
  conversationExists: boolean;
  history: Array<{ id?: string; role: string; content: string }>;
  historySummary?: unknown;
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
        let offset = 0;
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          offset: (n: number) => {
            offset = n;
            return chain;
          },
          limit: (n: number) => {
            if (table === schema.conversations)
              return Promise.resolve(
                world.conversationExists
                  ? [
                      {
                        id: CONVERSATION,
                        historySummary: world.historySummary ?? null,
                      },
                    ]
                  : [],
              );
            if (table === schema.messages)
              return Promise.resolve(
                [...world.history].reverse().slice(offset, offset + n),
              );
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

// `list_runs` is one of the interactive agent's pins. `set_budget` is not.
const GOVERNED_TOOLS = {
  list_runs: {
    description: "List runs",
    inputSchema: {},
    execute: async () => 1,
  },
  set_budget: { description: "Set", inputSchema: {}, execute: async () => 2 },
};

/** Every outcome the run recorder was sealed with, per test. */
let sealCalls: unknown[] = [];
/** Every history-summary frame the run recorder was given, per test. */
let summaryFrames: unknown[] = [];
/** Every steering manifest frame the run recorder was given, per test. */
const steeringFrames = (): AssistantSteeringFrame[] =>
  mocks.steeringManifest.mock.calls.map(
    (call) => call[0] as AssistantSteeringFrame,
  );

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  mocks.promptConfig.mockReturnValue({});
  mocks.publishedSteering.mockResolvedValue([]);
  mocks.steeringManifest.mockResolvedValue(undefined);
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
  mocks.readAssistantAgentState.mockResolvedValue(ASSISTANT);
  mocks.materializeTools.mockImplementation(async () => {
    mocks.log.push("materialize");
    return {
      tools: GOVERNED_TOOLS,
      nameMap: { list_runs: "list_runs", set_budget: "set_budget" },
      mutatingToolNames: ["set_budget"],
      governance: {},
    };
  });
  sealCalls = [];
  summaryFrames = [];
  mocks.openAssistantRun.mockImplementation(async () => {
    mocks.log.push("open-run");
    const receipts: unknown[] = [];
    return {
      runId: "run-uuid",
      runPublicId: "arun_0123456789abcdef012345",
      agentId: AGENT_ID,
      agentVersionId: AGENT_VERSION_ID,
      receipts,
      steeringManifest: mocks.steeringManifest,
      historySummary: async (frame: unknown) => {
        mocks.log.push("history-summary");
        summaryFrames.push(frame);
      },
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
    entityLabel: null,
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

  // R4 (#3370): an operator's `agent` kill switch on the assistant stops the
  // whole turn, before who pays is resolved and before anything is written.
  it("refuses a turn whose assistant agent is switched off, before funding and before any write", async () => {
    mocks.readAssistantAgentState.mockResolvedValueOnce({
      ...ASSISTANT,
      stoppedBy: { publicId: "edn_stop", reason: "incident 42" },
    });
    await expect(prepareAssistantTurn(request)).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantStoppedError &&
        e.code === "kill_switch" &&
        e.switchId === "edn_stop" &&
        e.message.includes("incident 42"),
    );
    expect(mocks.log).toEqual(["roles"]);
    expect(mocks.resolveModelFundingSource).not.toHaveBeenCalled();
    expect(mocks.evaluateTurnCreditGate).not.toHaveBeenCalled();
    expect(captured.inserts).toHaveLength(0);
    expect(mocks.openAssistantRun).not.toHaveBeenCalled();
    expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
  });

  describe("the model's identity on the organisation's own key (#3314)", () => {
    // A direct-vendor key sends the vendor's own spelling — `gpt-5.2`, the id
    // `api.openai.com` answers to. The catalog is keyed by gateway ids, so
    // asking it about the wire id answers "unknown model" and the effort the
    // person asked for is dropped on every turn, with nothing saying so.
    const openaiKey = {
      provider: "openai",
      apiKey: "sk-openai-0123456789",
      digest: "d-openai",
      modelMap: { balanced: "gpt-5.2" },
    };
    const onOwnKey = () => {
      mocks.resolveModelFundingSource.mockImplementation(async () => {
        mocks.log.push("funding");
        return { fundedBy: "org", modelKey: openaiKey, keyHint: "6789" };
      });
    };

    it("keeps a requested reasoning effort, asking the catalog about the catalog id", async () => {
      onOwnKey();
      await runTurn({ ...request, effort: "high" });
      expect(mocks.supportsReasoning).toHaveBeenCalledWith("openai/gpt-5.2");
      expect(mocks.supportsReasoning).not.toHaveBeenCalledWith("gpt-5.2");
      const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
      expect(turnInput.effort).toBe("high");
    });

    it("still sends the vendor's own spelling to the vendor", async () => {
      // The catalog id is for lookups. `api.openai.com` has no model called
      // `openai/gpt-5.2`.
      onOwnKey();
      await runTurn({ ...request, effort: "high" });
      const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
      expect(turnInput.model).toMatchObject({ modelId: "gpt-5.2" });
      expect(turnInput.credential).toEqual(openaiKey);
    });

    it("drops the effort when the catalog says the model does not reason", async () => {
      mocks.supportsReasoning.mockImplementation(() => false);
      onOwnKey();
      await runTurn({ ...request, effort: "high" });
      expect(mocks.runGovernedTurn.mock.calls[0]![0].effort).toBeUndefined();
    });
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
    ).toMatchObject({ createdById: "creator-1" });
    // The turn's credit debits are attributed to the same person.
    expect(mocks.runGovernedTurn.mock.calls[0]![0].telemetry).toMatchObject({
      userId: "creator-1",
    });

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
      toolCalls: [],
      stopped: false,
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
    // The agent the turn runs as, so a switch on it reaches the belt and the
    // call gate. The tools still run as the person.
    expect(materializeOpts.actingAgent).toEqual({
      agentId: "agt_assistant",
      principalId: "prn_assistant",
    });
    // finding 9 (macanderson/oxagen#3370): materializeTools runs before
    // openAssistantRun opens the run, so a tool call parked mid-turn reads
    // the run from a mutable ref rather than from `ctx.agentRun`, which is
    // unset at materialize time. By now the turn has finished, so the ref
    // already carries the run openAssistantRun opened.
    expect(materializeOpts.runIdRef).toEqual({
      current: "run-uuid",
    });
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
      // The turn meters its model calls on the person's message, so the run
      // names it for the cost rollup (#4167).
      originMessageId: "msg-user",
      maxSteps: 12,
      // The spec's tool policy is what the turn actually holds — the
      // materialised capabilities and the belt's two meta-tools. An empty
      // allowlist would read "no tools" on a run whose job is calling them.
      toolAllowlist: ["list_runs", "set_budget", SEARCH_TOOLS, LOAD_TOOLS],
    });

    // The engine is declared the whole belt plus the meta-tools; the model is
    // shown the interactive agent's pinned capability and the meta-tools; the
    // run is the ledger; the page context and the memory ride as context.
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS, "list_runs", "set_budget"].sort(),
    );
    expect(Object.keys(turnInput.modelTools()).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS, "list_runs"].sort(),
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
    // `userId` is the person who asked: every platform-paid debit of the turn
    // is written to credit_ledger.created_by_id under it, so a statement can
    // show assistant spend by operator. Before, the debits named nobody.
    expect(turnInput.telemetry).toEqual({
      orgId: "org-1",
      workspaceId: "ws-1",
      surface: "app",
      messageId: "msg-user",
      userId: "user-1",
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

  it("names a parked card by the approval's public id, not its row uuid", async () => {
    mocks.materializeTools.mockImplementationOnce(
      async (
        _ctx: unknown,
        opts: { onApprovalRequired: (e: unknown) => void },
      ) => {
        opts.onApprovalRequired({
          approvalId: "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c",
          approvalPublicId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
          capability: "set_budget",
          inputPreview: {},
          riskLevel: "high",
          expiresAt: "2026-09-14T10:05:00.000Z",
        });
        return {
          tools: GOVERNED_TOOLS,
          nameMap: {},
          mutatingToolNames: [],
          governance: {},
        };
      },
    );
    const result = await runTurn(request);
    // The flyout matches this id against list_approvals and
    // list_resolved_approvals, which answer public ids only.
    expect(result.parkedCards).toEqual([
      {
        approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
        capability: "set_budget",
        expiresAt: "2026-09-14T10:05:00.000Z",
      },
    ]);
  });

  it("lists each tool call behind the reply, with a parked call under its card's approval id (#4161)", async () => {
    const ROW_ID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";
    const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";
    let approvalRequired: ((e: unknown) => void) | undefined;
    mocks.materializeTools.mockImplementationOnce(
      async (
        _ctx: unknown,
        opts: { onApprovalRequired: (e: unknown) => void },
      ) => {
        approvalRequired = opts.onApprovalRequired;
        return {
          tools: GOVERNED_TOOLS,
          nameMap: {},
          mutatingToolNames: ["set_budget"],
          governance: {},
        };
      },
    );
    mocks.runGovernedTurn.mockImplementationOnce(
      async (args: { ledger: { toolCall: (r: unknown) => Promise<void> } }) => {
        await args.ledger.toolCall({
          seq: 2,
          requestId: "tc-1",
          toolName: "recall_memory",
          outcome: "completed",
          input: {},
          output: {},
          durationMs: 12.6,
        });
        // What a governed write that parks leaves behind: the gate opens the
        // approval, and the engine records the call as parked with the
        // approval's public id (#4196). The error names the same public id.
        approvalRequired?.({
          approvalId: ROW_ID,
          approvalPublicId: PUBLIC_ID,
          capability: "set_budget",
          inputPreview: {},
          riskLevel: "high",
          expiresAt: "2026-09-14T10:05:00.000Z",
        });
        await args.ledger.toolCall({
          seq: 3,
          requestId: "tc-2",
          toolName: "set_budget",
          outcome: "parked",
          approvalPublicId: PUBLIC_ID,
          input: {},
          error: `refused: set_budget is waiting for approval ${PUBLIC_ID} until 2026-09-14T10:05:00.000Z`,
          durationMs: 4,
        });
        return fakeTurn({});
      },
    );
    const result = await runTurn(request);
    expect(result.parkedCards.map((c) => c.approvalId)).toEqual([PUBLIC_ID]);
    expect(result.toolCalls).toEqual([
      {
        toolCallId: "tc-1",
        toolName: "recall_memory",
        outcome: "completed",
        durationMs: 13,
        approvalId: null,
      },
      {
        toolCallId: "tc-2",
        toolName: "set_budget",
        outcome: "parked",
        durationMs: 4,
        approvalId: PUBLIC_ID,
      },
    ]);
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

  describe("a long thread (#4171)", () => {
    const FACT = "My cost centre is CC-7741. Charge the migration to it.";
    /** 120 prior messages, oldest first, with the fact at message 3. */
    const longThread = () =>
      Array.from({ length: 120 }, (_, i) => ({
        id: `msg-${String(i + 1).padStart(3, "0")}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: i === 2 ? FACT : `message ${i + 1}`,
      }));

    beforeEach(() => {
      // The fake summariser keeps the cost centre when it is given it, as the
      // real one is told to keep every identifier.
      mocks.generateObjectFor.mockImplementation(
        async (args: { prompt: string }) => ({
          object: {
            summary: args.prompt.includes("CC-7741")
              ? "- The person's cost centre is CC-7741."
              : "- Nothing to keep.",
          },
          usage: { promptTokens: 900, completionTokens: 12, totalTokens: 912 },
        }),
      );
    });

    it("carries a fact from message 3 of a 120-message thread, and the run says a summary was used", async () => {
      setup({ history: longThread() });
      await runTurn(request);

      const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
      const history = turnInput.history as Array<{ content: string }>;
      // One summary, then the 40 newest messages word for word.
      expect(history).toHaveLength(41);
      expect(history[0]!.content).toContain("CC-7741");
      expect(history[1]!.content).toBe("message 81");
      expect(history.slice(1).some((m) => m.content === FACT)).toBe(false);

      // Summarised on the fast tier, on the turn's funding, as assistant use.
      expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
      expect(mocks.generateObjectFor.mock.calls[0]![0]).toMatchObject({
        model: { modelId: "model-for-fast" },
        fundedBy: "platform",
        chargeReason: "consume_assistant_tokens",
        telemetry: { surface: "app", messageId: "msg-user" },
      });

      expect(summaryFrames).toEqual([
        expect.objectContaining({
          outcome: "applied",
          regenerated: true,
          coveredMessages: 80,
          windowMessages: 40,
          text: "- The person's cost centre is CC-7741.",
        }),
      ]);
      // On the record before the engine is asked anything.
      expect(mocks.log.indexOf("history-summary")).toBeGreaterThan(
        mocks.log.indexOf("open-run"),
      );
      expect(mocks.log.indexOf("history-summary")).toBeLessThan(
        mocks.log.indexOf("engine"),
      );
      // Stored with the conversation for the turns after this one.
      expect(captured.updates).toContainEqual({
        table: schema.conversations,
        set: {
          historySummary: expect.objectContaining({
            throughMessageId: "msg-080",
            coveredMessages: 80,
          }),
        },
      });
    });

    it("reuses the stored summary on the next turn without asking a model", async () => {
      setup({ history: longThread() });
      await runTurn(request);
      const written = captured.updates.find(
        (u) => u.table === schema.conversations && "historySummary" in u.set,
      )!.set.historySummary;

      // The turn above added its two messages.
      setup({
        history: [
          ...longThread(),
          { id: "msg-121", role: "user", content: "which cost centre?" },
          { id: "msg-122", role: "assistant", content: "CC-7741." },
        ],
        historySummary: written,
      });
      mocks.generateObjectFor.mockClear();
      mocks.runGovernedTurn.mockClear();
      await runTurn(request);

      expect(mocks.generateObjectFor).not.toHaveBeenCalled();
      const next = mocks.runGovernedTurn.mock.calls[0]![0];
      const history = next.history as Array<{ content: string }>;
      expect(history).toHaveLength(43);
      expect(history[0]!.content).toContain("CC-7741");
      expect(summaryFrames.at(-1)).toMatchObject({
        outcome: "applied",
        regenerated: false,
      });
    });

    it("writes no summary frame for a thread that fits the window (negative)", async () => {
      await runTurn(request);
      expect(mocks.generateObjectFor).not.toHaveBeenCalled();
      expect(summaryFrames).toEqual([]);
      expect(mocks.log).not.toContain("history-summary");
    });
  });

  // #4158: published steering and the workspace's instructions reach the
  // prompt through the one assembler, and the run records what it kept and
  // cut before the engine is asked anything (ADR-093 §7). Before, the
  // instructions were refused whole past 8,000 characters and published
  // records never reached the assistant.
  describe("steering", () => {
    const INSTRUCTIONS = "Answer in British English and cite the run id.";
    const RECORD = {
      id: "ask-before-deleting",
      kind: "record",
      force: "must",
      body: "Ask before deleting data. (rule; ask-before-deleting)",
      recordedAt: "2026-09-10T00:00:00.000Z",
    };
    const systemOf = (): string =>
      mocks.runGovernedTurn.mock.calls[0]![0].system as string;

    it("carries published steering and the instructions in the prompt, and records the manifest before the engine", async () => {
      mocks.publishedSteering.mockResolvedValue([RECORD]);
      mocks.promptConfig.mockReturnValue({
        additionalInstructions: INSTRUCTIONS,
      });
      await runTurn(request);

      const system = systemOf();
      expect(system.startsWith("GOVERNANCE Acme/Core")).toBe(true);
      expect(system).toContain(
        "- Ask before deleting data. (rule; ask-before-deleting)",
      );
      expect(system).toContain(`- Workspace instructions: ${INSTRUCTIONS}`);
      // The published MUST record is listed before the instructions.
      expect(system.indexOf("Ask before deleting")).toBeLessThan(
        system.indexOf(INSTRUCTIONS),
      );

      const [frame, ...rest] = steeringFrames();
      expect(rest).toEqual([]);
      expect(frame!.manifest.items.map((i) => [i.id, i.outcome])).toEqual([
        ["ask-before-deleting", "included"],
        [WORKSPACE_INSTRUCTIONS_ID, "included"],
      ]);
      expect(frame!.manifest.text_digest).toMatch(/^sha256:/);
      expect(frame!.instructionsDigest).toBe(digestJcs(INSTRUCTIONS));
      expect(frame!.unavailableKinds).toEqual([]);
      // After the run is admitted and before the engine is asked anything,
      // so a turn that then fails still says what steered it.
      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder[0]!;
      expect(order(mocks.steeringManifest)).toBeGreaterThan(
        order(mocks.openAssistantRun),
      );
      expect(order(mocks.steeringManifest)).toBeLessThan(
        order(mocks.runGovernedTurn),
      );
    });

    it("cuts instructions past the budget: the prompt carries the records and the manifest names the cut (negative)", async () => {
      const oversized = "x".repeat(ASSISTANT_STEERING_BUDGET_TOKENS * 4 + 1);
      mocks.publishedSteering.mockResolvedValue([RECORD]);
      mocks.promptConfig.mockReturnValue({
        additionalInstructions: oversized,
      });
      await runTurn(request);

      const system = systemOf();
      expect(system).toContain("Ask before deleting data.");
      expect(system).not.toContain("xxxx");
      const [frame] = steeringFrames();
      expect(
        frame!.manifest.items.find((i) => i.id === WORKSPACE_INSTRUCTIONS_ID),
      ).toMatchObject({ outcome: "cut", reason: "budget" });
      expect(frame!.instructionsDigest).toBe(digestJcs(oversized));
      expect(mocks.runGovernedTurn).toHaveBeenCalledTimes(1);
    });

    it("records an empty manifest when nothing steers, and sends the baseline alone (negative)", async () => {
      await runTurn(request);
      expect(systemOf()).toBe("GOVERNANCE Acme/Core");
      const [frame] = steeringFrames();
      expect(frame!.manifest).toMatchObject({
        included: 0,
        cut: 0,
        text_digest: null,
        items: [],
      });
      expect(frame!.instructionsDigest).toBeNull();
    });

    it("runs on the instructions alone when the registry does not answer, and the manifest says so", async () => {
      mocks.publishedSteering.mockRejectedValue(new Error("registry is down"));
      mocks.promptConfig.mockReturnValue({
        additionalInstructions: INSTRUCTIONS,
      });
      await runTurn(request);

      expect(systemOf()).toContain(INSTRUCTIONS);
      const [frame] = steeringFrames();
      expect(frame!.unavailableKinds).toEqual(["record"]);
      expect(frame!.manifest.items.map((i) => i.id)).toEqual([
        WORKSPACE_INSTRUCTIONS_ID,
      ]);
    });

    it("does not run the turn when the record will not take the manifest", async () => {
      mocks.steeringManifest.mockRejectedValueOnce(
        new Error("ledger refused the steering frame"),
      );

      await expect(runTurn(request)).rejects.toThrow(
        "ledger refused the steering frame",
      );
      expect(mocks.runGovernedTurn).not.toHaveBeenCalled();
      // The run is sealed rather than left open, the same as any other
      // preflight refusal after admission.
      expect(sealCalls).toEqual([
        { status: "failed", error: "ledger refused the steering frame" },
      ]);
    });
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

    it("records a parked tool call as pending with the approval it waits on, not failed", async () => {
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
            outcome: "parked",
            approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
            input: { usd: 5 },
            error: "refused: set_budget is waiting for approval",
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
          responsePayload: {
            error: "refused: set_budget is waiting for approval",
            approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
          },
          status: "pending",
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

// R4 (#3370, finding 9): the turn materialises its tools before it opens its
// run, as the person who asked. This suite runs the real materializeTools, so
// the belt the engine receives is the one production builds. Before the fix a
// tool an emergency deny named reached the engine and the run's allowlist,
// because the listing read the denies only for an agent run, and this turn
// never carries one: not before the run opens, and not after.
describe("the belt the engine is handed", () => {
  const REGISTRY = [
    {
      name: "recall_memory",
      description: "Recall",
      surfaces: ["agent"],
      agent: { riskLevel: "low" },
      mutates: false,
      input: z.object({}),
    },
    {
      name: "set_budget",
      description: "Set",
      surfaces: ["agent"],
      agent: { riskLevel: "high" },
      input: z.object({}),
    },
  ];

  /** A kill switch on one tool: the shape `set_kill_switch` writes. */
  const killSwitch = (principalId: string | null = null) => ({
    publicId: "edn_set_budget",
    denyKind: "capability" as const,
    capabilityId: "set_budget",
    resourceScopeDigest: null,
    principalId,
    reason: "incident",
  });

  beforeEach(async () => {
    mocks.registry = REGISTRY;
    mocks.readActiveEmergencyDenies.mockResolvedValue([]);
    const real = await vi.importActual<typeof import("./materialize-tools")>(
      "./materialize-tools",
    );
    mocks.materializeTools.mockImplementation(
      async (...args: Parameters<typeof real.materializeTools>) => {
        mocks.log.push("materialize");
        return real.materializeTools(...args);
      },
    );
  });

  it("leaves a switched tool out of the engine's tools, the model's aliases, and the run's allowlist", async () => {
    mocks.readActiveEmergencyDenies.mockResolvedValue([killSwitch()]);
    const aliases: Array<Record<string, string>> = [];
    await runTurn(request, { onTools: (map) => aliases.push(map) });

    expect(mocks.readActiveEmergencyDenies).toHaveBeenCalledTimes(1);
    expect(mocks.readActiveEmergencyDenies).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: "org-1", workspaceId: "ws-1" },
    );
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS, "recall_memory"].sort(),
    );
    expect(aliases).toEqual([{ recall_memory: "recall_memory" }]);
    expect(mocks.openAssistantRun.mock.calls[0]![0].toolAllowlist).toEqual([
      "recall_memory",
      SEARCH_TOOLS,
      LOAD_TOOLS,
    ]);
    // The refusals keep their order: the credit gate before anything is
    // written, the belt before the run, the run before the engine.
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
  });

  it("carries no agent run before or after the run opens, so the order was never the cause", async () => {
    await runTurn(request);
    const [materializeCtx] = mocks.materializeTools.mock.calls[0]!;
    expect(materializeCtx).not.toHaveProperty("agentRun");
    // The execution record is written with the turn's context after the run
    // opened and sealed. It still names the person, not an agent run, so
    // opening the run first would have handed the listing nothing new.
    const execution = mocks.invoke.mock.calls.find(
      (c: unknown[]) => c[0] === "get_message_execution",
    );
    expect(execution![2]).toMatchObject({ userId: "user-1" });
    expect(execution![2]).not.toHaveProperty("agentRun");
  });

  it("leaves out a tool a deny names by the assistant agent's principal", async () => {
    mocks.readActiveEmergencyDenies.mockResolvedValue([
      killSwitch("prn_assistant"),
    ]);
    await runTurn(request);
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools)).not.toContain("set_budget");
    expect(Object.keys(turnInput.tools)).toContain("recall_memory");
  });

  it("leaves out every capability when the assistant agent is switched off after the turn began", async () => {
    // The turn's own check read no switch; the listing reads one. That is a
    // flip between the two reads, and the belt still honours it.
    mocks.readActiveEmergencyDenies.mockResolvedValue([
      {
        publicId: "edn_agent",
        denyKind: "resource_scope",
        capabilityId: null,
        resourceScopeDigest: resourceScopeDigestOf({
          kind: "agent",
          id: "agt_assistant",
        }),
        principalId: null,
        reason: "incident",
      },
    ]);
    await runTurn(request);
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools).sort()).toEqual(
      [LOAD_TOOLS, SEARCH_TOOLS].sort(),
    );
    expect(mocks.openAssistantRun.mock.calls[0]![0].toolAllowlist).toEqual([
      SEARCH_TOOLS,
      LOAD_TOOLS,
    ]);
  });

  it("keeps a tool whose deny names another principal (negative)", async () => {
    mocks.readActiveEmergencyDenies.mockResolvedValue([
      killSwitch("prn_someone_else"),
    ]);
    await runTurn(request);
    const turnInput = mocks.runGovernedTurn.mock.calls[0]![0];
    expect(Object.keys(turnInput.tools)).toContain("set_budget");
    expect(mocks.openAssistantRun.mock.calls[0]![0].toolAllowlist).toContain(
      "set_budget",
    );
  });
});

// A person's stop (#4164): the handler folds `cancel_assistant_turn`'s signal
// into `abortSignal`, which cancels the engine, and passes it as `stopSignal`
// too. The engine then ends the turn with its aborted outcome, and the turn
// keeps what was written as a stopped reply instead of refusing.
describe("a person's stop (#4164)", () => {
  const aborted = () =>
    Object.assign(new Error("stopped by the person who asked"), {
      code: "engine_aborted",
    });

  /** The hooks the handler passes once the person has pressed Stop. */
  function stoppedHooks(): AssistantTurnHooks {
    const stop = new AbortController();
    stop.abort("stopped by the person who asked");
    return { abortSignal: stop.signal, stopSignal: stop.signal };
  }

  /** A turn the engine ended aborted after the given parts. */
  function abortedTurn(parts: unknown[], text: string) {
    return {
      ...fakeTurn({ text }),
      fullStream: (async function* () {
        for (const part of parts) yield part;
        yield { type: "error", error: aborted() };
      })(),
    };
  }

  function assistantInsert() {
    return captured.inserts.find(
      (i) => i.table === schema.messages && i.values.role === "assistant",
    );
  }

  function executionStatus() {
    const call = mocks.invoke.mock.calls.find(
      (c: unknown[]) => c[0] === "get_message_execution",
    );
    return (call?.[1] as { status?: string } | undefined)?.status;
  }

  it("keeps the reply written before a stop mid-reply, marked stopped, and records the execution cancelled", async () => {
    mocks.runGovernedTurn.mockImplementationOnce(async () =>
      abortedTurn(
        [{ type: "text-delta", text: "The run failed at" }],
        "The run failed at",
      ),
    );
    const hooks = stoppedHooks();
    const result = await runTurn(request, hooks);

    expect(result).toMatchObject({ stopped: true, reply: "The run failed at" });
    expect(mocks.runGovernedTurn.mock.calls[0]![0].abortSignal).toBe(
      hooks.abortSignal,
    );
    expect(assistantInsert()?.values).toMatchObject({
      content: "The run failed at",
      metadata: { status: "stopped" },
    });
    expect(executionStatus()).toBe("cancelled");
  });

  it("saves an empty stopped reply when the stop lands before the first token", async () => {
    mocks.runGovernedTurn.mockImplementationOnce(async () =>
      abortedTurn([], ""),
    );
    const result = await runTurn(request, stoppedHooks());

    expect(result).toMatchObject({ stopped: true, reply: "" });
    expect(assistantInsert()?.values).toMatchObject({
      content: "",
      metadata: { status: "stopped" },
    });
    expect(executionStatus()).toBe("cancelled");
  });

  it("keeps the tool call a stop cut short on the execution record", async () => {
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
          toolName: "list_runs",
          outcome: "cancelled",
          input: {},
          durationMs: 40,
        });
        return abortedTurn(
          [
            { type: "text-delta", text: "Checking your runs." },
            { type: "tool-call", toolName: "list_runs", input: {} },
          ],
          "Checking your runs.",
        );
      },
    );
    const result = await runTurn(request, stoppedHooks());

    expect(result).toMatchObject({
      stopped: true,
      reply: "Checking your runs.",
    });
    const call = mocks.invoke.mock.calls.find(
      (c: unknown[]) => c[0] === "get_message_execution",
    );
    const input = call![1] as {
      status: string;
      steps: Array<{ toolCalls?: Array<Record<string, unknown>> }>;
    };
    expect(input.status).toBe("cancelled");
    expect(input.steps[0]!.toolCalls).toEqual([
      expect.objectContaining({ toolName: "list_runs", status: "failed" }),
    ]);
  });

  it("still refuses an abort that was not a stop: a disconnect or a budget stop (negative)", async () => {
    mocks.runGovernedTurn.mockImplementationOnce(async () =>
      abortedTurn([{ type: "text-delta", text: "partial" }], "partial"),
    );
    // The handler passes the stop signal whenever the caller minted a turn
    // id; nobody pressed Stop, so it is not aborted.
    const disconnect = new AbortController();
    disconnect.abort();
    const err = await runTurn(request, {
      abortSignal: disconnect.signal,
      stopSignal: new AbortController().signal,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "engine_aborted" });
    expect(assistantInsert()).toBeUndefined();
    expect(executionStatus()).toBeUndefined();
  });

  it("still refuses a failure that ended the turn before the stop landed (negative)", async () => {
    const failure = Object.assign(
      new Error("the assistant engine is unavailable"),
      { code: "engine_unavailable" },
    );
    mocks.runGovernedTurn.mockImplementationOnce(async () => ({
      ...fakeTurn({ text: "" }),
      fullStream: (async function* () {
        yield { type: "error", error: failure };
      })(),
    }));

    await expect(runTurn(request, stoppedHooks())).rejects.toBe(failure);
    expect(assistantInsert()).toBeUndefined();
  });

  it("refuses a stopped turn whose receipt could not be written (negative)", async () => {
    const unrecorded = Object.assign(new Error("receipt not written"), {
      code: "assistant_run_not_recorded",
    });
    const rejected = Promise.reject(unrecorded);
    rejected.catch(() => undefined);
    mocks.runGovernedTurn.mockImplementationOnce(async () => ({
      ...abortedTurn([{ type: "text-delta", text: "partial" }], "partial"),
      finalText: rejected,
    }));

    await expect(runTurn(request, stoppedHooks())).rejects.toBe(unrecorded);
    expect(assistantInsert()).toBeUndefined();
  });
});
