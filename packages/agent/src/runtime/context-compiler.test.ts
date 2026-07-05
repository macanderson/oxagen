/**
 * Unit tests for context-compiler.ts — compiles agent context via
 * @oxagen/engram and converts the resulting ContextWindow to a system message.
 *
 * @oxagen/engram, @oxagen/ai, @oxagen/ontology, and @oxagen/tenancy are all
 * mocked so no live compiler/store/Neo4j/gateway is needed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoist mocked factories before vi.mock ──────────────────────────────────
const engramMocks = vi.hoisted(() => {
  const compileSpy = vi.fn();
  const computeBudgetSpy = vi.fn().mockReturnValue({ maxTokens: 4096 });
  const createStoreSpy = vi.fn().mockReturnValue({ searchLexical: vi.fn().mockResolvedValue([]) });
  // Each retrieval engine is used as a constructor (`new XRetrievalEngine(...)`).
  const TemporalRetrievalEngineSpy = vi.fn().mockImplementation(() => ({}));
  const VectorRetrievalEngineSpy = vi.fn().mockImplementation(() => ({}));
  const GraphRetrievalEngineSpy = vi.fn().mockImplementation(() => ({}));
  const LexicalRetrievalEngineSpy = vi.fn().mockImplementation(() => ({}));

  return {
    compileSpy,
    computeBudgetSpy,
    createStoreSpy,
    TemporalRetrievalEngineSpy,
    VectorRetrievalEngineSpy,
    GraphRetrievalEngineSpy,
    LexicalRetrievalEngineSpy,
  };
});

const aiMocks = vi.hoisted(() => ({
  embedTextSpy: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

const ontologyMocks = vi.hoisted(() => {
  const sessionRunSpy = vi.fn().mockResolvedValue({ records: [] });
  const sessionCloseSpy = vi.fn().mockResolvedValue(undefined);
  const scopedSessionSpy = vi.fn().mockReturnValue({
    run: sessionRunSpy,
    close: sessionCloseSpy,
  });
  // Mirror the real oversampledLimit() shape (limit * 3, capped) closely
  // enough for assertions without importing @oxagen/ontology for real.
  const oversampledLimitSpy = vi.fn((limit: number) => limit * 3);
  return { sessionRunSpy, sessionCloseSpy, scopedSessionSpy, oversampledLimitSpy };
});

const tenancyMocks = vi.hoisted(() => ({
  runInTenantScopeSpy: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/engram", () => ({
  compile: engramMocks.compileSpy,
  computeBudget: engramMocks.computeBudgetSpy,
  createStore: engramMocks.createStoreSpy,
  TemporalRetrievalEngine: engramMocks.TemporalRetrievalEngineSpy,
  VectorRetrievalEngine: engramMocks.VectorRetrievalEngineSpy,
  GraphRetrievalEngine: engramMocks.GraphRetrievalEngineSpy,
  LexicalRetrievalEngine: engramMocks.LexicalRetrievalEngineSpy,
}));

vi.mock("@oxagen/ai", () => ({
  embedText: aiMocks.embedTextSpy,
}));

vi.mock("@oxagen/ontology", () => ({
  scopedSession: ontologyMocks.scopedSessionSpy,
  oversampledLimit: ontologyMocks.oversampledLimitSpy,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: tenancyMocks.runInTenantScopeSpy,
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
    engramMocks.createStoreSpy
      .mockReset()
      .mockReturnValue({ searchLexical: vi.fn().mockResolvedValue([]) });
    engramMocks.TemporalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.VectorRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.GraphRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.LexicalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    aiMocks.embedTextSpy.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
    ontologyMocks.scopedSessionSpy.mockReset().mockReturnValue({
      run: ontologyMocks.sessionRunSpy.mockReset().mockResolvedValue({ records: [] }),
      close: ontologyMocks.sessionCloseSpy.mockReset().mockResolvedValue(undefined),
    });
    ontologyMocks.oversampledLimitSpy.mockReset().mockImplementation((limit: number) => limit * 3);
    tenancyMocks.runInTenantScopeSpy.mockReset().mockImplementation((_scope, fn: () => unknown) => fn());
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
    const fakeStore = { type: "fake-store", searchLexical: vi.fn().mockResolvedValue([]) };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.TemporalRetrievalEngineSpy).toHaveBeenCalledWith(fakeStore);
  });

  // ── OXA-2061: Vector, Graph, and Lexical engines must be wired too ───────

  it("creates a VectorRetrievalEngine with the store, an embed function, and a vector query function", async () => {
    const fakeStore = { type: "fake-store", searchLexical: vi.fn().mockResolvedValue([]) };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.VectorRetrievalEngineSpy).toHaveBeenCalledWith(
      fakeStore,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("creates a GraphRetrievalEngine with the store and a graph query function", async () => {
    const fakeStore = { type: "fake-store", searchLexical: vi.fn().mockResolvedValue([]) };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.GraphRetrievalEngineSpy).toHaveBeenCalledWith(fakeStore, expect.any(Function));
  });

  it("creates a LexicalRetrievalEngine with the store and a lexical search function", async () => {
    const fakeStore = { type: "fake-store", searchLexical: vi.fn().mockResolvedValue([]) };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    expect(engramMocks.LexicalRetrievalEngineSpy).toHaveBeenCalledWith(fakeStore, expect.any(Function));
  });

  it("passes all four engines (temporal, vector, graph, lexical) to compile()", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);
    const [, , opts] = engramMocks.compileSpy.mock.calls[0] as [unknown, unknown, { engines: unknown[] }];
    expect(opts.engines).toHaveLength(4);
  });

  it("embed function calls embedText through @oxagen/ai with metered telemetry from ctx", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);

    const [, embedFn] = engramMocks.VectorRetrievalEngineSpy.mock.calls[0] as [unknown, (text: string) => Promise<number[]>];
    const embedding = await embedFn("task description text");

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(aiMocks.embedTextSpy).toHaveBeenCalledWith("task description text", {
      telemetry: {
        orgId: "org_1",
        workspaceId: "ws_1",
        surface: "runner",
        executionStepId: "msg_1",
      },
    });
  });

  it("vector query function over-samples via oversampledLimit and queries the engram_memory_embedding_index", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);

    ontologyMocks.sessionRunSpy.mockResolvedValueOnce({
      records: [
        { get: (k: string) => ({ recordId: "rec-1", score: 0.9 })[k] },
      ],
    });

    const [, , vectorQuery] = engramMocks.VectorRetrievalEngineSpy.mock.calls[0] as [
      unknown,
      unknown,
      (embedding: number[], opts: { orgId: string; workspaceId: string; limit: number }) => Promise<unknown>,
    ];
    const results = await vectorQuery([0.1, 0.2], { orgId: "org_1", workspaceId: "ws_1", limit: 10 });

    expect(tenancyMocks.runInTenantScopeSpy).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      expect.any(Function),
    );
    expect(ontologyMocks.oversampledLimitSpy).toHaveBeenCalledWith(10);
    expect(ontologyMocks.sessionRunSpy).toHaveBeenCalledWith(
      expect.stringContaining("engram_memory_embedding_index"),
      expect.objectContaining({ embedding: [0.1, 0.2], k: 30n, limit: 10n }),
    );
    expect(results).toEqual([{ recordId: "rec-1", score: 0.9 }]);
    expect(ontologyMocks.sessionCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("graph query function traverses :REMEMBERS/:ABOUT edges through scopedSession", async () => {
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);

    ontologyMocks.sessionRunSpy.mockResolvedValueOnce({
      records: [
        { get: (k: string) => ({ recordId: "rec-2", salience: 0.75 })[k] },
      ],
    });

    const [, graphQuery] = engramMocks.GraphRetrievalEngineSpy.mock.calls[0] as [
      unknown,
      (cypher: string, params: Record<string, unknown>) => Promise<unknown>,
    ];
    const cypher = "MATCH (entity)-[:REMEMBERS]->(m:EngramMemory) WHERE entity.id IN $workingSet RETURN m.recordId AS recordId";
    const results = await graphQuery(cypher, { workingSet: ["entity-1"], orgId: "org_1", workspaceId: "ws_1", limit: 20 });

    expect(tenancyMocks.runInTenantScopeSpy).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      expect.any(Function),
    );
    expect(ontologyMocks.sessionRunSpy).toHaveBeenCalledWith(cypher, {
      workingSet: ["entity-1"],
      orgId: "org_1",
      workspaceId: "ws_1",
      limit: 20,
    });
    expect(results).toEqual([{ recordId: "rec-2", salience: 0.75 }]);
  });

  it("lexical search function delegates to the store's searchLexical with the mapped namespace", async () => {
    const searchLexicalSpy = vi.fn().mockResolvedValue([{ recordId: "rec-3", score: 0.6 }]);
    const fakeStore = { type: "fake-store", searchLexical: searchLexicalSpy };
    engramMocks.createStoreSpy.mockReturnValueOnce(fakeStore);
    engramMocks.compileSpy.mockResolvedValueOnce(FAKE_WINDOW);
    await compileAgentContext(CTX, MESSAGES);

    const [, lexicalSearch] = engramMocks.LexicalRetrievalEngineSpy.mock.calls[0] as [
      unknown,
      (query: string, opts: { orgId: string; workspaceId: string; limit: number }) => Promise<unknown>,
    ];
    const results = await lexicalSearch("NullPointerException auth.ts:42", {
      orgId: "org_1",
      workspaceId: "ws_1",
      limit: 10,
    });

    expect(searchLexicalSpy).toHaveBeenCalledWith(
      { org: "org_1", workspace: "ws_1" },
      "NullPointerException auth.ts:42",
      10,
    );
    expect(results).toEqual([{ recordId: "rec-3", score: 0.6 }]);
  });
});

describe("compileAgentContext — error / fallback path", () => {
  beforeEach(() => {
    engramMocks.compileSpy.mockReset();
    engramMocks.computeBudgetSpy.mockReset().mockReturnValue({ maxTokens: 4096 });
    engramMocks.createStoreSpy
      .mockReset()
      .mockReturnValue({ searchLexical: vi.fn().mockResolvedValue([]) });
    engramMocks.TemporalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.VectorRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.GraphRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    engramMocks.LexicalRetrievalEngineSpy.mockReset().mockImplementation(() => ({}));
    aiMocks.embedTextSpy.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
    ontologyMocks.scopedSessionSpy.mockReset().mockReturnValue({
      run: ontologyMocks.sessionRunSpy.mockReset().mockResolvedValue({ records: [] }),
      close: ontologyMocks.sessionCloseSpy.mockReset().mockResolvedValue(undefined),
    });
    ontologyMocks.oversampledLimitSpy.mockReset().mockImplementation((limit: number) => limit * 3);
    tenancyMocks.runInTenantScopeSpy.mockReset().mockImplementation((_scope, fn: () => unknown) => fn());
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
