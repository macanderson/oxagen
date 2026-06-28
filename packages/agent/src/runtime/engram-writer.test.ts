/**
 * Unit tests for engram-writer.ts — emits agent episodic events to Engram
 * and fires graph-sync / embed events.
 *
 * @oxagen/engram is mocked entirely: both the static top-level imports
 * (emitGraphSync, emitEmbedEvent) and the dynamic import inside getEngram
 * (createEngram, createStore) resolve to spy functions.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoist spies before vi.mock ─────────────────────────────────────────────
const engramMocks = vi.hoisted(() => {
  const rememberSpy = vi.fn(async () => "record_id_1");
  const closeSpy = vi.fn(async () => undefined);

  const createEngramSpy = vi.fn(() => ({
    remember: rememberSpy,
    close: closeSpy,
  }));
  const createStoreSpy = vi.fn(() => ({}));
  const emitGraphSyncSpy = vi.fn(async () => undefined);
  const emitEmbedEventSpy = vi.fn(async () => undefined);

  return {
    rememberSpy,
    closeSpy,
    createEngramSpy,
    createStoreSpy,
    emitGraphSyncSpy,
    emitEmbedEventSpy,
  };
});

vi.mock("@oxagen/engram", () => ({
  createEngram: engramMocks.createEngramSpy,
  createStore: engramMocks.createStoreSpy,
  emitGraphSync: engramMocks.emitGraphSyncSpy,
  emitEmbedEvent: engramMocks.emitEmbedEventSpy,
}));

import {
  emitAgentEvent,
  emitToolCall,
  emitDecision,
  closeEngramWriter,
  clearEngramWriterForTests,
} from "./engram-writer";
import type { AgentEventContext } from "./engram-writer";

const CTX: AgentEventContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  sessionId: "sess_1",
  agentId: "agent_1",
  messageId: "msg_1",
};

describe("emitAgentEvent — core write path", () => {
  beforeEach(() => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockReset().mockResolvedValue("record_id_1");
    engramMocks.closeSpy.mockReset();
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitGraphSyncSpy.mockReset();
    engramMocks.emitEmbedEventSpy.mockReset();
  });

  it("calls engram.remember with the correct namespace and provenance", async () => {
    await emitAgentEvent(CTX, { event: "decision", payload: { decision: "proceed" } });

    expect(engramMocks.rememberSpy).toHaveBeenCalledTimes(1);
    const [, opts] = engramMocks.rememberSpy.mock.calls[0] as unknown as [
      unknown,
      {
        namespace: { org: string; workspace: string; session?: string; agent?: string };
        provenance: { author: string; derivedFrom: string[] };
      },
    ];
    expect(opts.namespace.org).toBe("org_1");
    expect(opts.namespace.workspace).toBe("ws_1");
    expect(opts.namespace.session).toBe("sess_1");
    expect(opts.namespace.agent).toBe("agent_1");
    expect(opts.provenance.author).toBe("agent_1");
    expect(opts.provenance.derivedFrom).toEqual(["msg_1"]);
  });

  it("provenance.author falls back to 'agent-runtime' when agentId is absent", async () => {
    const noAgentCtx = { ...CTX, agentId: undefined };
    await emitAgentEvent(noAgentCtx, { event: "decision", payload: {} });
    const [, opts] = engramMocks.rememberSpy.mock.calls[0] as unknown as [unknown, { provenance: { author: string } }];
    expect(opts.provenance.author).toBe("agent-runtime");
  });

  it("derivedFrom is empty when messageId is absent", async () => {
    const noMsgCtx = { ...CTX, messageId: undefined };
    await emitAgentEvent(noMsgCtx, { event: "decision", payload: {} });
    const [, opts] = engramMocks.rememberSpy.mock.calls[0] as unknown as [unknown, { provenance: { derivedFrom: string[] } }];
    expect(opts.provenance.derivedFrom).toEqual([]);
  });

  it("fires emitEmbedEvent on every successful remember call", async () => {
    await emitAgentEvent(CTX, { event: "tool_call", payload: "data" });
    expect(engramMocks.emitEmbedEventSpy).toHaveBeenCalledTimes(1);
    const [args] = engramMocks.emitEmbedEventSpy.mock.calls[0] as unknown as [
      { recordId: string; orgId: string; workspaceId: string; kind: string; body: string },
    ];
    expect(args.recordId).toBe("record_id_1");
    expect(args.orgId).toBe("org_1");
    expect(args.workspaceId).toBe("ws_1");
    expect(args.kind).toBe("episodic");
  });

  it("includes event name prefix in the embed body", async () => {
    await emitAgentEvent(CTX, { event: "my_event", payload: "payload text" });
    const [args] = engramMocks.emitEmbedEventSpy.mock.calls[0] as unknown as [{ body: string }];
    expect(args.body).toMatch(/^my_event:/);
    expect(args.body).toContain("payload text");
  });

  it("truncates embed body to 2000 chars", async () => {
    const bigPayload = "z".repeat(3000);
    await emitAgentEvent(CTX, { event: "big", payload: bigPayload });
    const [args] = engramMocks.emitEmbedEventSpy.mock.calls[0] as unknown as [{ body: string }];
    expect(args.body.length).toBeLessThanOrEqual(2000);
  });

  it("JSON-stringifies non-string payload for embed body", async () => {
    await emitAgentEvent(CTX, { event: "obj_event", payload: { nested: true } });
    const [args] = engramMocks.emitEmbedEventSpy.mock.calls[0] as unknown as [{ body: string }];
    expect(args.body).toContain('{"nested":true}');
  });
});

describe("emitAgentEvent — graph sync (nodeRef / entityRefs paths)", () => {
  beforeEach(() => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockReset().mockResolvedValue("record_id_2");
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitGraphSyncSpy.mockReset();
    engramMocks.emitEmbedEventSpy.mockReset();
  });

  it("fires emitGraphSync when nodeRef is provided", async () => {
    await emitAgentEvent(
      CTX,
      { event: "tool_call", payload: "invoke" },
      { nodeRef: "Function:foo" },
    );
    expect(engramMocks.emitGraphSyncSpy).toHaveBeenCalledTimes(1);
    const [args] = engramMocks.emitGraphSyncSpy.mock.calls[0] as unknown as [
      { recordId: string; orgId: string; workspaceId: string; nodeRef: string | null },
    ];
    expect(args.recordId).toBe("record_id_2");
    expect(args.orgId).toBe("org_1");
    expect(args.nodeRef).toBe("Function:foo");
  });

  it("fires emitGraphSync when entityRefs is non-empty", async () => {
    await emitAgentEvent(
      CTX,
      { event: "decision", payload: "route" },
      { entityRefs: ["node_1", "node_2"] },
    );
    expect(engramMocks.emitGraphSyncSpy).toHaveBeenCalledTimes(1);
    const [args] = engramMocks.emitGraphSyncSpy.mock.calls[0] as unknown as [
      { entityRefs: string[] | null },
    ];
    expect(args.entityRefs).toEqual(["node_1", "node_2"]);
  });

  it("does NOT fire emitGraphSync when no nodeRef or entityRefs", async () => {
    await emitAgentEvent(CTX, { event: "tool_call", payload: "data" });
    expect(engramMocks.emitGraphSyncSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire emitGraphSync when entityRefs is an empty array", async () => {
    await emitAgentEvent(CTX, { event: "x", payload: "y" }, { entityRefs: [] });
    expect(engramMocks.emitGraphSyncSpy).not.toHaveBeenCalled();
  });

  it("emitGraphSync receives kind 'episodic' and salience defaulting to 0.3", async () => {
    await emitAgentEvent(
      CTX,
      { event: "evt", payload: "p" },
      { nodeRef: "Class:Bar" },
    );
    const [args] = engramMocks.emitGraphSyncSpy.mock.calls[0] as unknown as [
      { kind: string; salience: number },
    ];
    expect(args.kind).toBe("episodic");
    expect(args.salience).toBe(0.3);
  });
});

describe("emitAgentEvent — error swallowing", () => {
  beforeEach(() => {
    clearEngramWriterForTests();
    engramMocks.emitGraphSyncSpy.mockReset();
    engramMocks.emitEmbedEventSpy.mockReset();
  });

  it("does not throw when engram.remember rejects", async () => {
    engramMocks.createEngramSpy.mockReturnValue({
      remember: vi.fn(async () => { throw new Error("db error"); }),
      close: engramMocks.closeSpy,
    });
    await expect(
      emitAgentEvent(CTX, { event: "test", payload: "data" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when emitEmbedEvent rejects", async () => {
    engramMocks.createEngramSpy.mockReturnValue({
      remember: vi.fn(async () => "id_ok"),
      close: engramMocks.closeSpy,
    });
    engramMocks.emitEmbedEventSpy.mockRejectedValueOnce(new Error("embed fail"));
    await expect(
      emitAgentEvent(CTX, { event: "test", payload: "data" }),
    ).resolves.toBeUndefined();
  });
});

describe("emitToolCall", () => {
  beforeEach(() => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockReset().mockResolvedValue("rc_3");
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitEmbedEventSpy.mockReset();
    engramMocks.emitGraphSyncSpy.mockReset();
  });

  it("calls engram.remember with event 'tool_call' and structured payload", async () => {
    await emitToolCall(CTX, "file.read", "success", { path: "/etc/hosts" });
    expect(engramMocks.rememberSpy).toHaveBeenCalledTimes(1);
    const [event] = engramMocks.rememberSpy.mock.calls[0] as unknown as [
      { event: string; payload: { tool: string; data: unknown }; outcome: string },
    ];
    expect(event.event).toBe("tool_call");
    expect(event.payload.tool).toBe("file.read");
    expect(event.payload.data).toEqual({ path: "/etc/hosts" });
    expect(event.outcome).toBe("success");
  });

  it("forwards outcome 'failure' correctly", async () => {
    await emitToolCall(CTX, "agent.run", "failure");
    const [event] = engramMocks.rememberSpy.mock.calls[0] as unknown as [{ outcome: string }];
    expect(event.outcome).toBe("failure");
  });

  it("forwards emitOpts.nodeRef to emitGraphSync", async () => {
    engramMocks.emitGraphSyncSpy.mockReset();
    await emitToolCall(CTX, "code.exec", "success", undefined, { nodeRef: "File:index.ts" });
    expect(engramMocks.emitGraphSyncSpy).toHaveBeenCalledTimes(1);
    const [args] = engramMocks.emitGraphSyncSpy.mock.calls[0] as unknown as [{ nodeRef: string }];
    expect(args.nodeRef).toBe("File:index.ts");
  });
});

describe("emitDecision", () => {
  beforeEach(() => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockReset().mockResolvedValue("rc_4");
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitEmbedEventSpy.mockReset();
    engramMocks.emitGraphSyncSpy.mockReset();
  });

  it("calls engram.remember with event 'decision' and decision text", async () => {
    await emitDecision(CTX, "route to handler A", "matches user intent");
    expect(engramMocks.rememberSpy).toHaveBeenCalledTimes(1);
    const [event] = engramMocks.rememberSpy.mock.calls[0] as unknown as [
      { event: string; payload: { decision: string; reasoning?: string } },
    ];
    expect(event.event).toBe("decision");
    expect(event.payload.decision).toBe("route to handler A");
    expect(event.payload.reasoning).toBe("matches user intent");
  });

  it("works without reasoning argument", async () => {
    await emitDecision(CTX, "abort");
    const [event] = engramMocks.rememberSpy.mock.calls[0] as unknown as [
      { payload: { reasoning?: string } },
    ];
    expect(event.payload.reasoning).toBeUndefined();
  });
});

describe("closeEngramWriter", () => {
  it("calls close() on the cached Engram instance and nulls it", async () => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockReset().mockResolvedValue("rc_5");
    engramMocks.closeSpy.mockReset();
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitEmbedEventSpy.mockReset();
    engramMocks.emitGraphSyncSpy.mockReset();

    // First, trigger engram initialization by emitting an event.
    await emitAgentEvent(CTX, { event: "x", payload: "y" });
    expect(engramMocks.closeSpy).not.toHaveBeenCalled();

    // Now close.
    await closeEngramWriter();
    expect(engramMocks.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call is a no-op when already closed", async () => {
    clearEngramWriterForTests();
    // No engram initialized — close should be safe to call.
    await expect(closeEngramWriter()).resolves.toBeUndefined();
    expect(engramMocks.closeSpy).not.toHaveBeenCalled();
  });
});

describe("Engram instance caching", () => {
  it("creates Engram only once across multiple emitAgentEvent calls", async () => {
    clearEngramWriterForTests();
    engramMocks.rememberSpy.mockResolvedValue("rc_cache");
    engramMocks.createEngramSpy.mockReset().mockReturnValue({
      remember: engramMocks.rememberSpy,
      close: engramMocks.closeSpy,
    });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.emitEmbedEventSpy.mockReset();
    engramMocks.emitGraphSyncSpy.mockReset();

    await emitAgentEvent(CTX, { event: "e1", payload: "p1" });
    await emitAgentEvent(CTX, { event: "e2", payload: "p2" });
    await emitAgentEvent(CTX, { event: "e3", payload: "p3" });

    // createEngram is called exactly once regardless of how many events are emitted.
    expect(engramMocks.createEngramSpy).toHaveBeenCalledTimes(1);
    expect(engramMocks.rememberSpy).toHaveBeenCalledTimes(3);
  });
});
