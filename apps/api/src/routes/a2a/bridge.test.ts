import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AgentForA2A } from "@oxagen/agent";
import type { A2ATaskRow } from "./task-store";

// ── mocks (vi.hoisted so the factories can reference them) ────────────────────
const h = vi.hoisted(() => {
  const state: { streamParts: unknown[] } = { streamParts: [] };
  // runCodingAgent double: drives the caller's onStreamPart with the scripted
  // parts (mirroring the engine's per-step fullStream tap) and returns the
  // turn's summed usage read from the last `finish` part's totalUsage.
  const runCodingAgent = vi.fn(
    async (opts: { onStreamPart?: (p: unknown) => void }) => {
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      for (const p of state.streamParts) {
        if (
          p &&
          typeof p === "object" &&
          (p as { type?: string }).type === "finish" &&
          (p as { totalUsage?: unknown }).totalUsage
        ) {
          usage = {
            ...usage,
            ...(p as { totalUsage: Record<string, number> }).totalUsage,
          };
        }
        opts.onStreamPart?.(p);
      }
      return {
        text: "",
        steps: 1,
        diff: "",
        changedFiles: [],
        usage,
        messages: [],
      };
    },
  );
  const insertEvents = vi.fn(async () => undefined);
  const updateTask = vi.fn(
    async (_ctx: unknown, _id: string, patch: Record<string, unknown>) => ({
      id: "task-uuid-1",
      publicId: "a2a_1",
      contextId: "ctx_1",
      state: patch.state ?? "working",
      messageHistory: [],
      artifacts: patch.artifacts ?? [],
      statusMessage: null,
      errorMessage: patch.errorMessage ?? null,
      updatedAt: new Date(),
    }),
  );
  const loadTask = vi.fn(
    async (_ctx: unknown, _taskId: string): Promise<A2ATaskRow | null> => null,
  );
  const resolveAgentForA2A = vi.fn(
    async (_workspaceId: string, _slug: string): Promise<AgentForA2A | null> =>
      null,
  );

  // Agent RBAC Q2: agent-run authz doubles. Default = a live agent principal
  // with no attached human (pure API-key caller) and an empty grants snapshot.
  const resolveAgentRunAuthzContext = vi.fn(
    async (args: { orgId: string; workspaceId: string; agentId: string }) => ({
      principalKind: "agent" as const,
      agentPrincipal: {
        id: "prn_agent_1",
        kind: "agent" as const,
        orgId: args.orgId,
        workspaceId: args.workspaceId,
      },
      humanPrincipal: null,
    }),
  );
  const fetchAgentRunAuthz = vi.fn(async () => ({
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
  }));

  // Minimal Postgres double for the agent_executions lineage writes
  // (insertExecutionRow/updateExecutionRow/findExecutionIdForTask in
  // bridge.ts). Records what was inserted/updated so lifecycle tests can
  // assert on it; the select branch (parentExecutionId lookup) resolves via
  // `selectResult`, settable per test.
  const dbState = {
    insertedValues: [] as Record<string, unknown>[],
    updatedSets: [] as Record<string, unknown>[],
    selectResult: [] as Array<{ id: string }>,
    insertReturns: { id: "exec_new" } as { id: string } | null,
  };
  const fakeTx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        dbState.insertedValues.push(v);
        return {
          returning: async () =>
            dbState.insertReturns ? [dbState.insertReturns] : [],
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        dbState.updatedSets.push(v);
        return { where: async () => [] };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbState.selectResult,
        }),
      }),
    }),
  };
  return {
    state,
    runCodingAgent,
    insertEvents,
    updateTask,
    loadTask,
    resolveAgentForA2A,
    resolveAgentRunAuthzContext,
    fetchAgentRunAuthz,
    dbState,
    fakeTx,
  };
});

vi.mock("@oxagen/iam", () => ({
  resolveAgentRunAuthzContext: h.resolveAgentRunAuthzContext,
  fetchAgentRunAuthz: h.fetchAgentRunAuthz,
}));
const {
  runCodingAgent,
  insertEvents,
  updateTask,
  loadTask,
  resolveAgentForA2A,
  dbState,
} = h;

vi.mock("@oxagen/ai", () => ({
  selectModel: vi.fn(() => ({ modelId: "test" })),
  modelIdOf: vi.fn(() => "test-model"),
  resolvePrompt: vi.fn(() => "system"),
  chatSystemPrompt: vi.fn(() => "baseline"),
  loadWorkspacePromptConfig: vi.fn(async () => ({})),
}));
vi.mock("@oxagen/agent", () => ({
  materializeTools: vi.fn(async () => ({
    tools: {},
    nameMap: { t: "tool.cap" },
  })),
  resolveAgentForA2A: h.resolveAgentForA2A,
}));
vi.mock("@oxagen/agent/adapters", () => ({
  createPlatformAgentAi: vi.fn(() => ({})),
}));
vi.mock("@oxagen/agent-runner", () => ({
  // The bridge enters the engine through the executeTurn seam (agent-engine
  // v2 Phase 1); the double keeps runCodingAgent's one-argument contract by
  // dropping the surface tag.
  executeTurn: vi.fn(
    (_surface: string, opts: Parameters<typeof h.runCodingAgent>[0]) =>
      h.runCodingAgent(opts),
  ),
  // The bridge imports DEFAULT_MAX_AGENT_STEPS for the maxSteps backstop; a
  // factory mock must declare every named export the source touches or Vitest
  // throws on access. The value is inert here (the runCodingAgent double ignores
  // maxSteps) — it only needs to exist. Mirrors the engine default.
  DEFAULT_MAX_AGENT_STEPS: 256,
}));
vi.mock("@oxagen/billing", () => ({
  // Budget off in these tests (CTX.userId is null) — the guard is undefined so
  // the turn runs unbounded, exactly as before this feature.
  createTurnBudgetGuard: vi.fn(() => undefined),
  TURN_BUDGET_OFF: {
    enabled: false,
    limitUsd: 0,
    mode: "prompt",
    graceOveragePct: 0.25,
  },
}));
vi.mock("@oxagen/handlers/budget.policy.read", () => ({
  budgetPolicyReadHandler: vi.fn(async () => ({
    enabled: false,
    limitUsd: null,
    mode: "prompt",
    graceOveragePct: 0.25,
  })),
}));
vi.mock("../v1/chat-memory", () => ({
  recallWorkspaceMemoryMessage: vi.fn(async () => null),
  createRecalledMemoryProvider: vi.fn(() => ({
    recallContext: async () => "",
    remember: () => undefined,
  })),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: h.insertEvents }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.fakeTx),
  };
});
vi.mock("./task-store", () => ({
  updateTask: h.updateTask,
  loadTask: h.loadTask,
}));

function setStreamParts(parts: unknown[]): void {
  h.state.streamParts = parts;
}

import { runA2ATask, messageText } from "./bridge";
import type { A2AMessage } from "./protocol";
import type { A2AStatusUpdateEvent, A2AArtifactUpdateEvent } from "./protocol";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: null,
  apiKeyId: "key_1",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const TASK: A2ATaskRow = {
  id: "task-uuid-1",
  publicId: "a2a_1",
  contextId: "ctx_1",
  state: "submitted",
  messageHistory: [],
  artifacts: [],
  statusMessage: null,
  errorMessage: null,
  updatedAt: new Date(),
};

const HISTORY = [
  {
    kind: "message" as const,
    role: "user" as const,
    parts: [{ kind: "text" as const, text: "hi" }],
    messageId: "m1",
  },
];

const USER_MESSAGE: A2AMessage = HISTORY[0]!;

beforeEach(() => {
  setStreamParts([]);
  runCodingAgent.mockClear();
  updateTask.mockClear();
  insertEvents.mockClear();
  loadTask.mockClear();
  resolveAgentForA2A.mockClear();
  loadTask.mockResolvedValue(null);
  resolveAgentForA2A.mockResolvedValue(null);
  dbState.insertedValues = [];
  dbState.updatedSets = [];
  dbState.selectResult = [];
  dbState.insertReturns = { id: "exec_new" };
});

describe("messageText", () => {
  it("joins text parts and ignores non-text", () => {
    expect(
      messageText({
        kind: "message",
        role: "user",
        messageId: "m",
        parts: [
          { kind: "text", text: "a" },
          { kind: "data", data: { x: 1 } },
          { kind: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });
});

describe("runA2ATask", () => {
  it("completes a task, builds the response artifact, and meters usage", async () => {
    setStreamParts([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
      { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const events: Array<{ kind: string }> = [];
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
      onEvent: (e) => events.push(e),
    });

    expect(final.state).toBe("completed");
    // Response artifact holds the accumulated text.
    const art = final.artifacts[0]!;
    expect(art.parts[0]).toMatchObject({ kind: "text", text: "Hello world" });

    // Streamed A2A events: working → artifact chunks → final completed.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("status-update");
    expect(kinds).toContain("artifact-update");
    const last = events[events.length - 1] as { kind: string; final: boolean };
    expect(last.kind).toBe("status-update");
    expect(last.final).toBe(true);

    // Token usage is metered via the engine's AI port; lifecycle events are
    // emitted to ClickHouse (started + completed at minimum).
    expect(runCodingAgent).toHaveBeenCalledOnce();
    const eventTypes = (
      insertEvents.mock.calls as unknown as Array<
        [Array<{ event_type: string }>]
      >
    ).map((c) => c[0][0]!.event_type);
    expect(eventTypes).toContain("a2a.task.started");
    expect(eventTypes).toContain("a2a.task.completed");
  });

  it("marks the task failed when the stream yields an error part", async () => {
    setStreamParts([{ type: "error", error: "rate limited" }]);
    const events: Array<{ kind: string; final?: boolean }> = [];
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
      onEvent: (e) => events.push(e),
    });
    expect(final.state).toBe("failed");
    expect(final.errorMessage).toBe("rate limited");
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ kind: "status-update", final: true });
    const eventTypes = (
      insertEvents.mock.calls as unknown as Array<
        [Array<{ event_type: string }>]
      >
    ).map((c) => c[0][0]!.event_type);
    expect(eventTypes).toContain("a2a.task.failed");
  });

  it("runs without onEvent (message/send blocking path)", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });
    expect(final.state).toBe("completed");
  });

  it("emits a working heartbeat with the capability name on tool-call", async () => {
    setStreamParts([
      { type: "tool-call", toolName: "t" },
      { type: "text-delta", text: "done" },
      { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const events: Array<A2AStatusUpdateEvent | A2AArtifactUpdateEvent> = [];
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
      onEvent: (e) => events.push(e),
    });
    const heartbeat = events.find((e) => {
      if (e.kind !== "status-update") return false;
      const part = e.status.message?.parts[0];
      return part?.kind === "text" && part.text.includes("tool.cap");
    });
    expect(heartbeat).toBeDefined();
  });

  it("marks the task failed when the engine throws", async () => {
    runCodingAgent.mockImplementationOnce(() => {
      throw new Error("model down");
    });
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });
    expect(final.state).toBe("failed");
    expect(final.errorMessage).toBe("model down");
  });

  it("honors an explicit model override", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
      model: "gpt-x",
    });
    expect(runCodingAgent).toHaveBeenCalledOnce();
  });
});

describe("runA2ATask — skill-addressed routing (spec §3.1)", () => {
  it("falls back to the generic baseline when the message carries no skillId", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });
    expect(resolveAgentForA2A).not.toHaveBeenCalled();
  });

  it("resolves an active/deployed skill and layers its instructions over the chat baseline", async () => {
    resolveAgentForA2A.mockResolvedValueOnce({
      id: "agt-uuid-1",
      publicId: "agt_1",
      slug: "billing-bot",
      name: "Billing Bot",
      description: null,
      avatarUrl: null,
      summary: null,
      summaryChecksum: null,
      agentType: "custom",
      status: "active",
      deploymentStatus: "active",
      activeVersionId: "ver-1",
      activeVersion: { id: "ver-1", instructions: "Only discuss billing." },
    });
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const messageWithSkill: A2AMessage = {
      ...USER_MESSAGE,
      metadata: { skillId: "billing-bot" },
    };
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: messageWithSkill,
    });
    expect(resolveAgentForA2A).toHaveBeenCalledWith("ws_1", "billing-bot");
    // The task row's routing column is updated in the same "working" transition write.
    const workingCall = updateTask.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>).state === "working",
    );
    expect((workingCall?.[2] as Record<string, unknown>).agentId).toBe(
      "agt-uuid-1",
    );
  });

  it("falls back to generic (never throws) when resolveAgentForA2A rejects", async () => {
    resolveAgentForA2A.mockRejectedValueOnce(new Error("db down"));
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const messageWithSkill: A2AMessage = {
      ...USER_MESSAGE,
      metadata: { skillId: "flaky-skill" },
    };
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: messageWithSkill,
    });
    expect(final.state).toBe("completed");
  });

  it("falls back to generic when the skillId names an unknown/inactive agent", async () => {
    resolveAgentForA2A.mockResolvedValueOnce(null);
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const messageWithSkill: A2AMessage = {
      ...USER_MESSAGE,
      metadata: { skillId: "archived-agent" },
    };
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: messageWithSkill,
    });
    expect(final.state).toBe("completed");
    const workingCall = updateTask.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>).state === "working",
    );
    expect((workingCall?.[2] as Record<string, unknown>).agentId).toBeNull();
  });
});

describe("runA2ATask — agent_executions lineage (spec §3.2)", () => {
  it("inserts one agent_executions row (originType a2a) on the working transition, updated on completion", async () => {
    setStreamParts([
      { type: "text-delta", text: "hi" },
      { type: "finish", totalUsage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });

    expect(dbState.insertedValues).toHaveLength(1);
    const inserted = dbState.insertedValues[0]!;
    expect(inserted.originType).toBe("a2a");
    expect(inserted.originId).toBe(TASK.id);
    expect(inserted.status).toBe("running");
    expect(inserted.parentExecutionId).toBeNull();

    expect(dbState.updatedSets).toHaveLength(1);
    const updated = dbState.updatedSets[0]!;
    expect(updated.status).toBe("completed");
    expect(updated.inputTokens).toBe(3);
    expect(updated.outputTokens).toBe(2);
  });

  it("marks the execution row failed on a stream error", async () => {
    setStreamParts([{ type: "error", error: "boom" }]);
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });
    expect(dbState.updatedSets).toHaveLength(1);
    expect(dbState.updatedSets[0]!.status).toBe("failed");
    expect(dbState.updatedSets[0]!.failureReason).toBe("boom");
  });

  it("chains parentExecutionId from message.referenceTaskIds[0]", async () => {
    loadTask.mockResolvedValueOnce({
      id: "prior-task-uuid",
      publicId: "a2a_prior",
      contextId: "ctx_1",
      state: "completed",
      messageHistory: [],
      artifacts: [],
      statusMessage: null,
      errorMessage: null,
      updatedAt: new Date(),
    } satisfies A2ATaskRow);
    dbState.selectResult = [{ id: "prior-exec-uuid" }];
    setStreamParts([{ type: "text-delta", text: "ok" }]);

    const referencing: A2AMessage = {
      ...USER_MESSAGE,
      referenceTaskIds: ["a2a_prior"],
    };
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: referencing,
    });

    expect(loadTask).toHaveBeenCalledWith(CTX, "a2a_prior");
    expect(dbState.insertedValues[0]!.parentExecutionId).toBe(
      "prior-exec-uuid",
    );
  });

  it("leaves parentExecutionId null when the referenced task can't be resolved", async () => {
    loadTask.mockResolvedValueOnce(null);
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const referencing: A2AMessage = {
      ...USER_MESSAGE,
      referenceTaskIds: ["a2a_missing"],
    };
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: referencing,
    });
    expect(dbState.insertedValues[0]!.parentExecutionId).toBeNull();
  });

  it("does not fail the task when the agent_executions insert throws (best-effort lineage)", async () => {
    dbState.insertReturns = null;
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const final = await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
    });
    expect(final.state).toBe("completed");
    // No executionId (insert returned no row) — the terminal update never runs.
    expect(dbState.updatedSets).toHaveLength(0);
  });
});

// A2A JSON-RPC wire snapshot (task D). The bridge was refactored to run through
// runCodingAgent (multi-step tool loop, invoke()-gated tools, per-turn memory
// recall, USD budget guard) instead of a single hand-rolled streamAgentReply.
// The A2A protocol wire — the sequence of status-update / artifact-update events
// pushed to onEvent — MUST be preserved: the same part→event mapping now runs in
// the engine's onStreamPart tap. This test captures a representative turn's
// events and writes them (with volatile ids/timestamps normalized) to a
// verifications snapshot so any protocol drift is caught.
describe("runA2ATask — JSON-RPC wire snapshot (task D)", () => {
  it("preserves the status-update / artifact-update event sequence", async () => {
    setStreamParts([
      { type: "tool-call", toolName: "t" },
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
      { type: "finish", totalUsage: { inputTokens: 12, outputTokens: 8 } },
    ]);
    const events: Array<Record<string, unknown>> = [];
    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: USER_MESSAGE,
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    // Normalize volatile fields (random messageId/artifactId, timestamps) so the
    // snapshot asserts structure + ordering, not run-specific ids.
    const normalize = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(normalize);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k === "messageId" || k === "artifactId") out[k] = `<${k}>`;
          else if (k === "timestamp") out[k] = "<timestamp>";
          else out[k] = normalize(val);
        }
        return out;
      }
      return v;
    };

    const normalized = events.map(normalize);
    const kinds = events.map((e) => e.kind);

    // Structural invariants of the A2A protocol wire.
    expect(kinds[0]).toBe("status-update"); // working transition
    expect(kinds).toContain("artifact-update"); // streamed prose chunks
    const last = events[events.length - 1] as { kind: string; final: boolean };
    expect(last.kind).toBe("status-update");
    expect(last.final).toBe(true); // terminal completed

    // Every artifact-update carries the response artifact with text parts.
    for (const e of events) {
      if (e.kind === "artifact-update") {
        const art = e.artifact as {
          name: string;
          parts: Array<{ kind: string }>;
        };
        expect(art.name).toBe("response");
        expect(art.parts[0]!.kind).toBe("text");
      }
    }

    const dir = join(
      __dirname,
      "../../../../../verifications/session_01WQkDajXjxLXveaPhWzsup7",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a2a-bridge-jsonrpc-snapshot.txt"),
      JSON.stringify(normalized, null, 2) + "\n",
      "utf8",
    );
  });
});

// ── Agent RBAC Q2 — target-agent principal ∩ caller scope (spec §6 Q2) ─────────

describe("runA2ATask — agent RBAC delegation (Q2)", () => {
  const AGENT_ROW = {
    id: "agt-uuid-1",
    publicId: "agt_1",
    slug: "billing-bot",
    name: "Billing Bot",
    description: null,
    avatarUrl: null,
    summary: null,
    summaryChecksum: null,
    agentType: "custom" as const,
    status: "active",
    deploymentStatus: "active",
    activeVersionId: "ver-1",
    activeVersion: { id: "ver-1", instructions: "Only discuss billing." },
  };

  it("threads the target agent's agentRun into tool materialization", async () => {
    resolveAgentForA2A.mockResolvedValueOnce(AGENT_ROW as never);
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const { materializeTools } = await import("@oxagen/agent");
    vi.mocked(materializeTools).mockClear();

    await runA2ATask({
      ctx: CTX,
      task: TASK,
      history: HISTORY,
      message: { ...USER_MESSAGE, metadata: { skillId: "billing-bot" } },
    });

    expect(h.resolveAgentRunAuthzContext).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_1", initiatingUserId: null }),
    );
    const matCtx = vi.mocked(materializeTools).mock.calls[0]?.[0] as {
      agentRun?: { agentId: string; resolution?: unknown };
    };
    expect(matCtx.agentRun).toBeDefined();
    expect(matCtx.agentRun!.agentId).toBe("agt_1");
    // The one-per-run snapshot is prefetched so BOTH layers read it.
    expect(matCtx.agentRun!.resolution).toBeDefined();
    expect(h.fetchAgentRunAuthz).toHaveBeenCalledTimes(1);
  });

  it("fails the task closed when the target agent has no live principal", async () => {
    resolveAgentForA2A.mockResolvedValueOnce(AGENT_ROW as never);
    h.resolveAgentRunAuthzContext.mockResolvedValueOnce(null as never);
    setStreamParts([{ type: "text-delta", text: "ok" }]);

    await expect(
      runA2ATask({
        ctx: CTX,
        task: TASK,
        history: HISTORY,
        message: { ...USER_MESSAGE, metadata: { skillId: "billing-bot" } },
      }),
    ).rejects.toThrow(/failing closed/);
  });

  it("attaches no agentRun for a generic non-agent-addressed task", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const { materializeTools } = await import("@oxagen/agent");
    vi.mocked(materializeTools).mockClear();

    await runA2ATask({ ctx: CTX, task: TASK, history: HISTORY, message: USER_MESSAGE });

    const matCtx = vi.mocked(materializeTools).mock.calls[0]?.[0] as {
      agentRun?: unknown;
    };
    expect(matCtx.agentRun).toBeUndefined();
  });
});
