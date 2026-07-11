/**
 * memory-capture.test.ts
 *
 * Unit tests proving the server chat turn path actually calls the Engram
 * emitters (emitAgentEvent/emitToolCall) — the specific defect this module
 * fixes: those emitters previously had zero callers anywhere in the repo.
 *
 * @oxagen/agent/runtime/engram-writer is mocked so no real Engram store,
 * Inngest client, or ClickHouse sink is touched — the mock supplies just the
 * two functions this module calls, matching the credit-gate.test.ts pattern
 * for this directory (mock the dependency, assert the wiring, no DB).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodingEvent } from "@oxagen/agent-engine";
import type { AgentEventContext } from "./memory-capture";

const emitAgentEventMock = vi.fn().mockResolvedValue(undefined);
const emitToolCallMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@oxagen/agent/runtime/engram-writer", () => ({
  emitAgentEvent: (...args: unknown[]) => emitAgentEventMock(...args),
  emitToolCall: (...args: unknown[]) => emitToolCallMock(...args),
}));

const { createChatEngramOnEvent, emitChatTurnMemory } = await import(
  "./memory-capture"
);

const CTX: AgentEventContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  sessionId: "conv-1",
  agentId: "agt-1",
  messageId: "msg-1",
};

// Flush the microtask queue so fire-and-forget (`void emit...(...)`) calls
// have a chance to run before an assertion checks the mock.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createChatEngramOnEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a tool call on tool-result (ok=true → success)", async () => {
    const onEvent = createChatEngramOnEvent(CTX);
    onEvent({
      type: "tool-result",
      name: "read_file",
      input: '{"path":"a.ts"}',
      result: "file contents",
      durationMs: 42,
      ok: true,
    });
    await flush();

    expect(emitToolCallMock).toHaveBeenCalledTimes(1);
    expect(emitToolCallMock).toHaveBeenCalledWith(CTX, "read_file", "success", {
      input: '{"path":"a.ts"}',
      result: "file contents",
      durationMs: 42,
    });
  });

  it("emits a tool call on tool-result (ok=false → failure)", async () => {
    const onEvent = createChatEngramOnEvent(CTX);
    onEvent({
      type: "tool-result",
      name: "bash",
      input: '{"command":"exit 1"}',
      result: "command failed",
      durationMs: 10,
      ok: false,
    });
    await flush();

    expect(emitToolCallMock).toHaveBeenCalledWith(CTX, "bash", "failure", {
      input: '{"command":"exit 1"}',
      result: "command failed",
      durationMs: 10,
    });
  });

  it("ignores tool-call events (no outcome/duration yet)", async () => {
    const onEvent = createChatEngramOnEvent(CTX);
    onEvent({ type: "tool-call", name: "read_file", input: {} });
    await flush();
    expect(emitToolCallMock).not.toHaveBeenCalled();
  });

  it.each<CodingEvent["type"]>([
    "text",
    "reasoning",
    "file-edit",
    "command",
    "final-diff",
  ])("ignores %s events", async (type) => {
    const onEvent = createChatEngramOnEvent(CTX);
    const events: Record<string, CodingEvent> = {
      text: { type: "text", delta: "hi" },
      reasoning: { type: "reasoning", delta: "thinking" },
      "file-edit": { type: "file-edit", path: "a.ts", bytes: 10, kind: "update" },
      command: { type: "command", command: "ls", exitCode: 0 },
      "final-diff": { type: "final-diff", diff: "", changedFiles: [] },
    };
    onEvent(events[type]!);
    await flush();
    expect(emitToolCallMock).not.toHaveBeenCalled();
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("never emits cross-tenant — the ctx passed in is forwarded verbatim", async () => {
    const otherCtx: AgentEventContext = { orgId: "org-2", workspaceId: "ws-2" };
    const onEvent = createChatEngramOnEvent(otherCtx);
    onEvent({
      type: "tool-result",
      name: "grep",
      input: "{}",
      result: "ok",
      durationMs: 1,
      ok: true,
    });
    await flush();
    expect(emitToolCallMock).toHaveBeenCalledWith(
      otherCtx,
      "grep",
      "success",
      expect.anything(),
    );
    // Never the OTHER context — proves no shared/ambient state leaks between calls.
    expect(emitToolCallMock).not.toHaveBeenCalledWith(
      CTX,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("emitChatTurnMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a chat_turn episodic event with the turn summary", () => {
    emitChatTurnMemory(CTX, {
      instruction: "explain the billing gate",
      responseLength: 512,
      changedFiles: [],
      steps: 3,
      outcome: "success",
    });

    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    expect(emitAgentEventMock).toHaveBeenCalledWith(CTX, {
      event: "chat_turn",
      payload: {
        instruction: "explain the billing gate",
        responseLength: 512,
        changedFiles: [],
        steps: 3,
      },
      outcome: "success",
    });
  });

  it("carries a failure outcome through", () => {
    emitChatTurnMemory(CTX, {
      instruction: "fix the bug",
      responseLength: 0,
      changedFiles: ["a.ts"],
      steps: 1,
      outcome: "failure",
    });

    expect(emitAgentEventMock).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ outcome: "failure" }),
    );
  });

  it("is fire-and-forget — does not return a promise the caller must await", () => {
    const result = emitChatTurnMemory(CTX, {
      instruction: "x",
      responseLength: 1,
      changedFiles: [],
      steps: 1,
      outcome: "success",
    });
    expect(result).toBeUndefined();
  });
});
