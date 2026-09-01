import { describe, it, expect, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { AgentMemoryRecallOutput } from "@oxagen/oxagen/contracts/agent.memory.recall";
import {
  formatRecalledMemories,
  recallWorkspaceMemoryMessage,
} from "./chat-memory";

type Mem = AgentMemoryRecallOutput["memories"][number];

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: "req_1",
};

function memory(overrides: Partial<Mem> = {}): Mem {
  return {
    id: "m1",
    nodeRef: "node_1",
    memoryClass: "RULE",
    memoryKind: "convention",
    lesson: "Always  use\nwithTenantDb",
    source: "session",
    confidenceScore: 0.9,
    enforcementScore: 5,
    score: 0.8,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatRecalledMemories", () => {
  it("returns null for no memories", () => {
    expect(formatRecalledMemories([])).toBeNull();
  });

  it("renders bullets with collapsed whitespace + enforcement for RULEs", () => {
    const body = formatRecalledMemories([memory()])!;
    expect(body).toContain("## Recalled workspace memory (prior sessions)");
    expect(body).toContain("NOT user input");
    expect(body).toContain(
      "- [RULE·convention] Always use withTenantDb (enforcement 5)",
    );
  });

  it("omits enforcement for non-RULE classes", () => {
    const body = formatRecalledMemories([
      memory({ memoryClass: "FACT", enforcementScore: null }),
    ])!;
    expect(body).toContain("- [FACT·convention]");
    expect(body).not.toContain("enforcement");
  });
});

describe("recallWorkspaceMemoryMessage", () => {
  it("returns null for an empty query without invoking", async () => {
    const invokeFn = vi.fn();
    const msg = await recallWorkspaceMemoryMessage({
      query: "   ",
      executionRef: "req_1",
      ctx: CTX,
      invokeFn: invokeFn as never,
    });
    expect(msg).toBeNull();
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("invokes agent.memory.recall (agent surface) and builds a volatile user message", async () => {
    const invokeFn = vi.fn(async () => ({ memories: [memory()] }));
    const msg = await recallWorkspaceMemoryMessage({
      query: "how do I query the db",
      executionRef: "req_1",
      ctx: CTX,
      invokeFn: invokeFn as never,
    });
    expect(invokeFn).toHaveBeenCalledOnce();
    const call = invokeFn.mock.calls[0] as unknown as unknown[];
    expect(call[0]).toBe("recall_memory");
    expect(call[1]).toMatchObject({
      query: "how do I query the db",
      executionRef: "req_1",
    });
    expect(call[3]).toEqual({ surface: "agent" });
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
    expect(typeof msg!.content === "string" && msg!.content).toContain(
      "[RULE·convention]",
    );
  });

  it("degrades to null when the invoke rejects (best-effort)", async () => {
    const invokeFn = vi.fn(async () => {
      throw new Error("neo4j down");
    });
    const msg = await recallWorkspaceMemoryMessage({
      query: "x",
      executionRef: "req_1",
      ctx: CTX,
      invokeFn: invokeFn as never,
    });
    expect(msg).toBeNull();
  });

  it("degrades to null when the output fails schema validation", async () => {
    const invokeFn = vi.fn(async () => ({ memories: [{ bad: "shape" }] }));
    const msg = await recallWorkspaceMemoryMessage({
      query: "x",
      executionRef: "req_1",
      ctx: CTX,
      invokeFn: invokeFn as never,
    });
    expect(msg).toBeNull();
  });

  it("degrades to null on timeout", async () => {
    const invokeFn = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ memories: [] }), 50),
        ),
    );
    const msg = await recallWorkspaceMemoryMessage({
      query: "x",
      executionRef: "req_1",
      ctx: CTX,
      invokeFn: invokeFn as never,
      timeoutMs: 1,
    });
    expect(msg).toBeNull();
  });
});
