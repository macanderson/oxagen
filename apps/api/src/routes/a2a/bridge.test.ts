import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── mocks (vi.hoisted so the factories can reference them) ────────────────────
const h = vi.hoisted(() => {
  const state: { streamParts: unknown[] } = { streamParts: [] };
  const streamAgentReply = vi.fn(() => ({
    fullStream: (async function* () {
      for (const p of state.streamParts) yield p;
    })(),
  }));
  const insertEvents = vi.fn(async () => undefined);
  const updateTask = vi.fn(
    async (_ctx: unknown, _id: string, patch: Record<string, unknown>) => ({
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
  return { state, streamAgentReply, insertEvents, updateTask };
});
const { streamAgentReply, insertEvents, updateTask } = h;

vi.mock("@oxagen/ai", () => ({
  streamAgentReply: h.streamAgentReply,
  selectModel: vi.fn(() => ({ modelId: "test" })),
  resolvePrompt: vi.fn(() => "system"),
  chatSystemPrompt: vi.fn(() => "baseline"),
  loadWorkspacePromptConfig: vi.fn(async () => ({})),
}));
vi.mock("@oxagen/agent", () => ({
  materializeTools: vi.fn(async () => ({ tools: {}, nameMap: { t: "tool.cap" } })),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: h.insertEvents }));
vi.mock("./task-store", () => ({ updateTask: h.updateTask }));

function setStreamParts(parts: unknown[]): void {
  h.state.streamParts = parts;
}

import { runA2ATask, messageText } from "./bridge";
import type { A2ATaskRow } from "./task-store";
import type {
  A2AStatusUpdateEvent,
  A2AArtifactUpdateEvent,
} from "./protocol";

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
  { kind: "message" as const, role: "user" as const, parts: [{ kind: "text" as const, text: "hi" }], messageId: "m1" },
];

beforeEach(() => {
  setStreamParts([]);
  streamAgentReply.mockClear();
  updateTask.mockClear();
  insertEvents.mockClear();
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

    // Token usage is metered via streamAgentReply telemetry; lifecycle events
    // are emitted to ClickHouse (started + completed at minimum).
    expect(streamAgentReply).toHaveBeenCalledOnce();
    const eventTypes = (
      insertEvents.mock.calls as unknown as Array<[Array<{ event_type: string }>]>
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
      onEvent: (e) => events.push(e),
    });
    expect(final.state).toBe("failed");
    expect(final.errorMessage).toBe("rate limited");
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ kind: "status-update", final: true });
    const eventTypes = (
      insertEvents.mock.calls as unknown as Array<[Array<{ event_type: string }>]>
    ).map((c) => c[0][0]!.event_type);
    expect(eventTypes).toContain("a2a.task.failed");
  });

  it("runs without onEvent (message/send blocking path)", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    const final = await runA2ATask({ ctx: CTX, task: TASK, history: HISTORY });
    expect(final.state).toBe("completed");
  });

  it("emits a working heartbeat with the capability name on tool-call", async () => {
    setStreamParts([
      { type: "tool-call", toolName: "t" },
      { type: "text-delta", text: "done" },
      { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const events: Array<A2AStatusUpdateEvent | A2AArtifactUpdateEvent> = [];
    await runA2ATask({ ctx: CTX, task: TASK, history: HISTORY, onEvent: (e) => events.push(e) });
    const heartbeat = events.find((e) => {
      if (e.kind !== "status-update") return false;
      const part = e.status.message?.parts[0];
      return part?.kind === "text" && part.text.includes("tool.cap");
    });
    expect(heartbeat).toBeDefined();
  });

  it("marks the task failed when streamAgentReply throws", async () => {
    streamAgentReply.mockImplementationOnce(() => {
      throw new Error("model down");
    });
    const final = await runA2ATask({ ctx: CTX, task: TASK, history: HISTORY });
    expect(final.state).toBe("failed");
    expect(final.errorMessage).toBe("model down");
  });

  it("honors an explicit model override", async () => {
    setStreamParts([{ type: "text-delta", text: "ok" }]);
    await runA2ATask({ ctx: CTX, task: TASK, history: HISTORY, model: "gpt-x" });
    expect(streamAgentReply).toHaveBeenCalledOnce();
  });
});
