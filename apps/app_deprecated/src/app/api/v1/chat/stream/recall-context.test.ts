/**
 * recall-context.test.ts — unit tests for the deterministic memory-recall
 * injection used by the chat stream route.
 *
 * Covers:
 *   (a) recallWorkspaceMemory invokes agent.memory.recall with the latest user
 *       text (truncated), a bounded limit, and the turn's executionRef, and
 *       returns a volatile user message carrying the recalled lessons.
 *   (b) recall failure / empty result / timeout → null (turn proceeds untouched).
 *   (c) stripRecalledMemoryHeading drops our "##" heading (the engine adds its
 *       own) while keeping the anti-injection preamble.
 *   (d) formatRecalledMemories renders RULE enforcement and returns null on empty.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
import type { CapabilityContext } from "@oxagen/oxagen";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { logger } from "@oxagen/handlers/logger";
import { graphNodeGet } from "@oxagen/oxagen/contracts/graph.node.get";
import {
  formatRecalledMemories,
  buildRecalledMemoryMessage,
  recallWorkspaceMemory,
  recallWorkspaceMemoryDetailed,
  resolveGroundingCitations,
} from "./recall-context";

type RecalledMemory = Parameters<typeof formatRecalledMemories>[0][number];

function memory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    id: "m-1",
    nodeRef: "node-1",
    memoryClass: "OBSERVATION",
    memoryKind: "bug",
    lesson: "The Stripe webhook tunnel secret rotates per dev session.",
    source: "session",
    confidenceScore: 80,
    enforcementScore: null,
    score: 0.9,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const CTX: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: "msg-1",
  clientIp: null,
} as CapabilityContext;

describe("formatRecalledMemories", () => {
  it("returns null when there are no memories (no empty section)", () => {
    expect(formatRecalledMemories([])).toBeNull();
  });

  it("renders one bullet per memory with class·kind tag", () => {
    const body = formatRecalledMemories([
      memory({ memoryClass: "OBSERVATION", memoryKind: "bug", lesson: "A" }),
    ]);
    expect(body).toContain("## Recalled workspace memory (prior sessions)");
    expect(body).toContain("- [OBSERVATION·bug] A");
    expect(body).toContain("never violate a RULE");
  });

  it("annotates RULE memories with their enforcement score", () => {
    const body = formatRecalledMemories([
      memory({
        memoryClass: "RULE",
        memoryKind: "convention",
        lesson: "Use withTenantDb",
        enforcementScore: 90,
      }),
    ]);
    expect(body).toContain(
      "- [RULE·convention] Use withTenantDb (enforcement 90)",
    );
  });

  it("collapses whitespace in multi-line lessons onto one bullet", () => {
    const body = formatRecalledMemories([
      memory({ lesson: "line one\n   line two" }),
    ]);
    expect(body).toContain("line one line two");
    expect(body).not.toContain("line one\n");
  });
});

describe("buildRecalledMemoryMessage", () => {
  it("returns null when empty", () => {
    expect(buildRecalledMemoryMessage([])).toBeNull();
  });

  it("returns a user-role message when memories exist", () => {
    const msg = buildRecalledMemoryMessage([memory()]);
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("user");
    expect(String(msg?.content)).toContain("Recalled workspace memory");
  });
});

describe("recallWorkspaceMemory", () => {
  it("invokes agent.memory.recall with the latest user text, a bounded limit, and executionRef", async () => {
    const invokeFn = vi
      .fn()
      .mockResolvedValue({ memories: [memory({ lesson: "Prior lesson" })] });

    const msg = await recallWorkspaceMemory({
      query: "why did the deploy fail?",
      executionRef: "exec-42",
      ctx: CTX,
      invokeFn,
    });

    expect(invokeFn).toHaveBeenCalledTimes(1);
    const [name, input, ctxArg, opts] = invokeFn.mock.calls[0]!;
    expect(name).toBe(agentMemoryRecall.name);
    expect(input).toMatchObject({
      query: "why did the deploy fail?",
      limit: 6,
      executionRef: "exec-42",
    });
    expect(ctxArg).toBe(CTX);
    expect(opts).toMatchObject({ surface: "agent" });

    expect(msg?.role).toBe("user");
    expect(String(msg?.content)).toContain("Prior lesson");
  });

  it("truncates the query to 500 chars before recall", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ memories: [] });
    await recallWorkspaceMemory({
      query: "x".repeat(900),
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    const input = invokeFn.mock.calls[0]![1] as { query: string };
    expect(input.query).toHaveLength(500);
  });

  it("returns null (turn untouched) AND logs a breadcrumb when recall throws", async () => {
    vi.mocked(logger.warn).mockClear();
    const invokeFn = vi.fn().mockRejectedValue(new Error("neo4j down"));
    const msg = await recallWorkspaceMemory({
      query: "anything",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
    // Fault must be observable, not silently swallowed.
    expect(logger.warn).toHaveBeenCalled();
    const [, warnMsg] = vi.mocked(logger.warn).mock.calls[0] as [
      unknown,
      string,
    ];
    expect(warnMsg).toContain("recall failed");
  });

  it("returns null when recall yields no memories", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ memories: [] });
    const msg = await recallWorkspaceMemory({
      query: "anything",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
  });

  it("returns null when an empty/whitespace query would produce a useless recall", async () => {
    const invokeFn = vi.fn();
    const msg = await recallWorkspaceMemory({
      query: "   ",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("returns null when recall exceeds the timeout budget", async () => {
    // Never resolves — the timeout race must win and yield null.
    const invokeFn = vi.fn(() => new Promise<unknown>(() => {}));
    const msg = await recallWorkspaceMemory({
      query: "slow",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
      timeoutMs: 10,
    });
    expect(msg).toBeNull();
  });
});

describe("recallWorkspaceMemoryDetailed", () => {
  it("returns both the volatile message and the raw memories on success", async () => {
    const invokeFn = vi.fn().mockResolvedValue({
      memories: [memory({ id: "m-9", lesson: "Detailed lesson" })],
    });

    const { message, memories } = await recallWorkspaceMemoryDetailed({
      query: "how does billing work?",
      executionRef: "exec-9",
      ctx: CTX,
      invokeFn,
    });

    expect(message?.role).toBe("user");
    expect(String(message?.content)).toContain("Detailed lesson");
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe("m-9");
  });

  it("returns an empty result (message null, memories []) when recall throws", async () => {
    const invokeFn = vi.fn().mockRejectedValue(new Error("neo4j down"));
    const result = await recallWorkspaceMemoryDetailed({
      query: "anything",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(result).toEqual({ message: null, memories: [] });
  });

  it("returns an empty result for a blank query without invoking recall", async () => {
    const invokeFn = vi.fn();
    const result = await recallWorkspaceMemoryDetailed({
      query: "   ",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(result).toEqual({ message: null, memories: [] });
    expect(invokeFn).not.toHaveBeenCalled();
  });
});

describe("resolveGroundingCitations", () => {
  const nodeOutput = (
    over: Partial<{ nodeId: string; label: string; displayName: string }> = {},
  ) => ({
    node: {
      nodeId: over.nodeId ?? "node-1",
      label: over.label ?? "Feature",
      displayName: over.displayName ?? "Metered Billing",
      description: "The usage→billing loop",
      properties: { owner: "platform" },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: null,
    },
  });

  it("returns [] for no memories and never invokes the graph", async () => {
    const invokeFn = vi.fn();
    const hits = await resolveGroundingCitations({
      memories: [],
      ctx: CTX,
      invokeFn,
    });
    expect(hits).toEqual([]);
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("resolves each memory's grounding node via graph.node.get and attaches a KnowledgeNodeRef", async () => {
    const invokeFn = vi
      .fn()
      .mockResolvedValue(nodeOutput({ nodeId: "node-1" }));
    const hits = await resolveGroundingCitations({
      memories: [
        memory({ id: "m-1", nodeRef: "node-1", lesson: "Grounded fact" }),
      ],
      ctx: CTX,
      invokeFn,
    });

    expect(invokeFn).toHaveBeenCalledTimes(1);
    const [name, input, ctxArg, opts] = invokeFn.mock.calls[0]!;
    expect(name).toBe(graphNodeGet.name);
    expect(input).toEqual({ nodeId: "node-1" });
    expect(ctxArg).toBe(CTX);
    expect(opts).toMatchObject({ surface: "agent" });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.lesson).toBe("Grounded fact");
    expect(hits[0]!.node).toMatchObject({
      id: "node-1",
      label: "Feature",
      displayName: "Metered Billing",
    });
    // description folded into the property bag for hover/inspect.
    expect(hits[0]!.node?.properties).toMatchObject({
      owner: "platform",
      description: "The usage→billing loop",
    });
  });

  it("dedups repeated nodeRefs to a single graph lookup", async () => {
    const invokeFn = vi
      .fn()
      .mockResolvedValue(nodeOutput({ nodeId: "node-1" }));
    const hits = await resolveGroundingCitations({
      memories: [
        memory({ id: "m-1", nodeRef: "node-1" }),
        memory({ id: "m-2", nodeRef: "node-1" }),
      ],
      ctx: CTX,
      invokeFn,
    });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.node?.id).toBe("node-1");
    expect(hits[1]!.node?.id).toBe("node-1");
  });

  it("leaves node undefined when the graph lookup fails (best-effort)", async () => {
    const invokeFn = vi.fn().mockRejectedValue(new Error("boom"));
    const hits = await resolveGroundingCitations({
      memories: [memory({ id: "m-1", nodeRef: "node-1" })],
      ctx: CTX,
      invokeFn,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.node).toBeUndefined();
    // The citation still carries the lesson + raw nodeRef for a fallback display.
    expect(hits[0]!.lesson).toBeTruthy();
    expect(hits[0]!.nodeRef).toBe("node-1");
  });

  it("leaves node undefined when the node is not found (null)", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ node: null });
    const hits = await resolveGroundingCitations({
      memories: [memory({ id: "m-1", nodeRef: "node-x" })],
      ctx: CTX,
      invokeFn,
    });
    expect(hits[0]!.node).toBeUndefined();
  });

  it("does not invoke the graph for memories that carry no nodeRef", async () => {
    const invokeFn = vi.fn();
    const hits = await resolveGroundingCitations({
      memories: [memory({ id: "m-1", nodeRef: "" })],
      ctx: CTX,
      invokeFn,
    });
    expect(invokeFn).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.node).toBeUndefined();
  });
});
