/**
 * Unit tests for context-compiler.ts — compiles agent context via
 * @oxagen/engram and converts the resulting ContextWindow to a system message.
 *
 * @oxagen/engram is mocked so no live compiler/store is needed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoist mocked factories before vi.mock ──────────────────────────────────
const engramMocks = vi.hoisted(() => {
  const compileSpy = vi.fn();
  const computeBudgetSpy = vi.fn().mockReturnValue({ maxTokens: 4096 });
  const createStoreSpy = vi.fn().mockReturnValue({});
  // TemporalRetrievalEngine is used as a constructor (`new TemporalRetrievalEngine(store)`)
  const TemporalRetrievalEngineSpy = vi.fn().mockImplementation(() => ({}));

  return { compileSpy, computeBudgetSpy, createStoreSpy, TemporalRetrievalEngineSpy };
});

vi.mock("@oxagen/engram", () => ({
  compile: engramMocks.compileSpy,
  computeBudget: engramMocks.computeBudgetSpy,
  createStore: engramMocks.createStoreSpy,
  TemporalRetrievalEngine: engramMocks.TemporalRetrievalEngineSpy,
  emitGraphSync: vi.fn(),
  emitEmbedEvent: vi.fn(),
}));

import { compileAgentContext, windowToSystemMessage } from "./context-compiler";
import type { CapabilityContext } from "../types";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: "msg_1",
};

const MESSAGES = [
  { role: "user", content: "what does this code do?" },
];

const FAKE_WINDOW = {
  sections: [
    { content: "section A" },
    { content: "section B" },
  ],
  tokenUsage: { total: 100, bySection: {} },
  cachePrefix: { stableBytes: 50, totalBytes: 100, hitRate: 0.5 },
  metadata: { compiledAt: Date.now(), retrievalMs: 5, packingMs: 3, layoutMs: 2 },
};

describe("windowToSystemMessage", () => {
  it("joins sections with double newlines and separator", () => {
    const result = windowToSystemMessage(FAKE_WINDOW as unknown as Parameters<typeof windowToSystemMessage>[0]);
    expect(result).toBe("section A\n\n---\n\nsection B");
  });

  it("returns empty string when sections array is empty", () => {
    const result = windowToSystemMessage({
      ...FAKE_WINDOW,
      sections: [],
    } as unknown as Parameters<typeof windowToSystemMessage>[0]);
    expect(result).toBe("");
  });

  it("returns a single section's content without separator", () => {
    const result = windowToSystemMessage({
      ...FAKE_WINDOW,
      sections: [{ content: "only section" }],
    } as unknown as Parameters<typeof windowToSystemMessage>[0]);
    expect(result).toBe("only section");
  });

  it("joins three sections with two separators", () => {
    const result = windowToSystemMessage({
      ...FAKE_WINDOW,
      sections: [
        { content: "part 1" },
        { content: "part 2" },
        { content: "part 3" },
      ],
    } as unknown as Parameters<typeof windowToSystemMessage>[0]);
    expect(result).toBe("part 1\n\n---\n\npart 2\n\n---\n\npart 3");
  });
});

describe("compileAgentContext — success path", () => {
  beforeEach(() => {
    engramMocks.compileSpy.mockReset();
    engramMocks.computeBudgetSpy.mockReset().mockReturnValue({ maxTokens: 4096 });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.TemporalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
  });

  it("returns a ContextWindow on success", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    const result = await compileAgentContext(CTX, MESSAGES);
    expect(result).toBe(FAKE_WINDOW);
  });

  it("calls compile() with a TaskFrame built from ctx and messages", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.compileSpy).toHaveBeenCalledTimes(1);
    const [taskFrame, budget] = engramMocks.compileSpy.mock.calls[0] as [
      { namespace: { org: string; workspace: string }; taskDescription: string },
      unknown,
    ];
    expect(taskFrame.namespace.org).toBe("org_1");
    expect(taskFrame.namespace.workspace).toBe("ws_1");
    expect(taskFrame.taskDescription).toBe("what does this code do?");
    expect(budget).toEqual({ maxTokens: 4096 });
  });

  it("passes candidatesPerEngine and diversityConstraint to compile()", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    const [, , opts] = engramMocks.compileSpy.mock.calls[0] as [unknown, unknown, {
      candidatesPerEngine: number;
      diversityConstraint: number;
      systemPrompt: string;
    }];
    expect(opts.candidatesPerEngine).toBe(20);
    expect(opts.diversityConstraint).toBe(3);
    expect(opts.systemPrompt).toBe("");
  });

  it("calls computeBudget and createStore", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.computeBudgetSpy).toHaveBeenCalledTimes(1);
    expect(engramMocks.createStoreSpy).toHaveBeenCalledTimes(1);
  });

  it("creates a TemporalRetrievalEngine with the store", async () => {
    const fakeStore = { type: "fake-store" };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.TemporalRetrievalEngineSpy).toHaveBeenCalledWith(fakeStore);
  });
});

describe("compileAgentContext — error / fallback path", () => {
  beforeEach(() => {
    engramMocks.compileSpy.mockReset();
    engramMocks.computeBudgetSpy.mockReset().mockReturnValue({ maxTokens: 4096 });
    engramMocks.createStoreSpy.mockReset().mockReturnValue({});
    engramMocks.TemporalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
  });

  it("returns null when compile() rejects", async () => {
    engramMocks.compileSpy.mockRejectedValueOnce(new Error("compile exploded"));
    const result = await compileAgentContext(CTX, MESSAGES);
    expect(result).toBeNull();
  });

  it("returns null when createStore throws", async () => {
    engramMocks.createStoreSpy.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    const result = await compileAgentContext(CTX, MESSAGES);
    expect(result).toBeNull();
  });

  it("does not throw even on unexpected errors — always returns null on failure", async () => {
    engramMocks.compileSpy.mockRejectedValueOnce(new TypeError("type error"));
    await expect(compileAgentContext(CTX, MESSAGES)).resolves.toBeNull();
  });
});
