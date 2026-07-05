import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared after it.
vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { recordExecutionInGraph, type RecordExecutionInput } from "./record-execution";

const mockScopedSession = vi.mocked(scopedSession);

const BASE_INPUT: RecordExecutionInput = {
  executionId: "aex-unit-001",
  orgId: "org-test",
  workspaceId: "ws-test",
  status: "completed",
  originType: "chat",
  originId: "conv-origin-001",
  agentId: "agt-001",
  startedAt: "2026-06-08T09:00:00Z",
  completedAt: "2026-06-08T09:00:10Z",
  latencyMs: 10000,
  inputTokens: 800,
  outputTokens: 200,
  estimatedCostUsd: "0.003200",
  toolCalls: [{ toolName: "web.search", toolType: "builtin" }],
};

const FAKE_EMBEDDING = new Array(1536).fill(0.1);

describe("recordExecutionInGraph", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  // ── GraphNode anchor + is_system on the node ─────────────────────────────

  it("adds :GraphNode anchor label in the MERGE Cypher", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const firstCall = mockNeoRun.mock.calls[0];
    expect(firstCall).toBeDefined();
    const cypher = firstCall![0] as string;
    expect(cypher).toContain("e:GraphNode");
  });

  it("sets is_system = true on the Execution node in both ON CREATE and ON MATCH", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    // is_system must appear in both SET blocks, not just one
    const matches = cypher.match(/is_system\s*=\s*true/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("sets label = 'Execution' on the node", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("e.label");
    expect(cypher).toContain("'Execution'");
  });

  it("sets publicId = executionId on CREATE", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("e.publicId");
    expect(cypher).toContain("$executionId");
  });

  it("sets displayName from input when provided", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, displayName: "chat execution by agt-001" });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.displayName).toBe("chat execution by agt-001");
  });

  it("falls back to '<originType> execution' as displayName when not provided", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, displayName: undefined });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.displayName).toBe("chat execution");
  });

  it("sets properties as a JSON string containing status and originType", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(typeof params.properties).toBe("string");
    const parsed = JSON.parse(params.properties as string) as Record<string, unknown>;
    expect(parsed.status).toBe("completed");
    expect(parsed.originType).toBe("chat");
  });

  it("includes toolNames in the properties bag when toolCalls are provided", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    const parsed = JSON.parse(params.properties as string) as Record<string, unknown>;
    expect(parsed.toolNames).toEqual(["web.search"]);
  });

  it("sets summary when provided", async () => {
    const summary = "chat execution by agent agt-001: completed, 1 tool call, 200 output tokens";
    await recordExecutionInGraph({ ...BASE_INPUT, summary });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.summary).toBe(summary);
  });

  // ── Embedding (conditional FOREACH guard) ────────────────────────────────

  it("includes FOREACH embedding guard in the Cypher", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, embedding: FAKE_EMBEDDING });

    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("FOREACH");
    expect(cypher).toContain("$embedding");
    expect(cypher).toContain("e.embeddingUpdatedAt");
  });

  it("passes the embedding vector as a param when provided", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, embedding: FAKE_EMBEDDING });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.embedding).toEqual(FAKE_EMBEDDING);
  });

  it("passes embedding = null when embedding is not provided (no vector overwrite)", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, embedding: undefined });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.embedding).toBeNull();
  });

  it("passes embedding = null when embedding is explicitly null", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, embedding: null });

    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.embedding).toBeNull();
  });

  // ── Edge is_system = true ────────────────────────────────────────────────

  it("sets is_system = true on the INVOKED edge to Agent", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const agentCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes(":Agent"),
    );
    expect(agentCall).toBeDefined();
    const cypher = agentCall![0] as string;
    expect(cypher).toContain("r.is_system = true");
    expect(cypher).toContain("INVOKED");
  });

  it("sets is_system = true on the ORIGINATED_FROM edge", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "chat" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    const cypher = originCall![0] as string;
    expect(cypher).toContain("r.is_system = true");
  });

  it("sets is_system = true on the CALLED_TOOL edges via UNWIND", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const toolCallCypher = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("CALLED_TOOL"),
    );
    expect(toolCallCypher).toBeDefined();
    const cypher = toolCallCypher![0] as string;
    expect(cypher).toContain("r.is_system = true");
    expect(cypher).toContain("UNWIND");
  });

  // ── Existing behaviour preserved ─────────────────────────────────────────

  it("runs a MERGE Cypher for the Execution node", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const firstCall = mockNeoRun.mock.calls[0];
    expect(firstCall).toBeDefined();
    const cypher = firstCall![0] as string;
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Execution");
    expect(cypher).toContain("$executionId");
  });

  it("creates INVOKED edge to Agent node when agentId is provided", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const agentCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes(":Agent"),
    );
    expect(agentCall).toBeDefined();
    expect(agentCall![0]).toContain("INVOKED");
  });

  it("skips Agent edge when agentId is null", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, agentId: null });

    const agentCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes(":Agent"),
    );
    expect(agentCall).toBeUndefined();
  });

  it("creates ORIGINATED_FROM edge to Conversation for chat origin", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "chat" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    expect(originCall![0]).toContain(":Conversation");
  });

  it("creates ORIGINATED_FROM edge to WorkflowRun for workflow_run origin", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "workflow_run" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    expect(originCall![0]).toContain(":WorkflowRun");
  });

  it("creates ORIGINATED_FROM edge to Fanout for fanout origin (Phase 2 §2)", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "fanout", originId: "fan-001" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeDefined();
    expect(originCall![0]).toContain(":Fanout");
    expect(originCall![1]).toMatchObject({ originId: "fan-001" });
  });

  it("merges caller-supplied properties into the node's properties bag", async () => {
    await recordExecutionInGraph({
      ...BASE_INPUT,
      originType: "fanout",
      properties: { fanoutId: "fan-001", runId: "sar-001", capabilityName: "web.search", attempts: 2, dropped: null },
    });

    const mergeCall = mockNeoRun.mock.calls[0]!;
    const params = mergeCall[1] as Record<string, unknown>;
    const parsed = JSON.parse(params.properties as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      fanoutId: "fan-001",
      runId: "sar-001",
      capabilityName: "web.search",
      attempts: 2,
      originType: "fanout",
    });
    expect(parsed).not.toHaveProperty("dropped");
  });

  it("skips ORIGINATED_FROM edge for unknown originType", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, originType: "scheduled_job" });

    const originCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("ORIGINATED_FROM"),
    );
    expect(originCall).toBeUndefined();
  });

  it("creates CALLED_TOOL edges for all toolCalls in a single UNWIND query", async () => {
    const toolCalls = [
      { toolName: "web.search", toolType: "builtin" },
      { toolName: "document.create", toolType: "capability" },
    ];
    await recordExecutionInGraph({ ...BASE_INPUT, toolCalls });

    const toolCallCyphers = mockNeoRun.mock.calls.filter(([cypher]) =>
      (cypher as string).includes("CALLED_TOOL"),
    );
    // UNWIND collapses all tool-call MERGEs into one round-trip (no N+1).
    expect(toolCallCyphers).toHaveLength(1);
    expect(toolCallCyphers[0]![0]).toContain("UNWIND");
    const params = toolCallCyphers[0]![1] as Record<string, unknown>;
    expect(params.toolCalls).toEqual(toolCalls);
  });

  it("skips CALLED_TOOL edges when toolCalls is empty", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, toolCalls: [] });

    const toolCallCyphers = mockNeoRun.mock.calls.filter(([cypher]) =>
      (cypher as string).includes("CALLED_TOOL"),
    );
    expect(toolCallCyphers).toHaveLength(0);
  });

  it("always calls close() even if run() throws", async () => {
    mockNeoRun.mockRejectedValueOnce(new Error("Neo4j unreachable"));

    await expect(recordExecutionInGraph(BASE_INPUT)).rejects.toThrow("Neo4j unreachable");
    expect(mockNeoClose).toHaveBeenCalledOnce();
  });

  it("passes status, latency, and token fields to the MERGE params", async () => {
    await recordExecutionInGraph(BASE_INPUT);

    const mergeCall = mockNeoRun.mock.calls[0];
    const params = mergeCall![1] as Record<string, unknown>;
    expect(params.status).toBe("completed");
    expect(params.latencyMs).toBe(10000);
    expect(params.inputTokens).toBe(800);
    expect(params.outputTokens).toBe(200);
  });

  it("is idempotent — two calls with same executionId both succeed", async () => {
    await recordExecutionInGraph(BASE_INPUT);
    await recordExecutionInGraph(BASE_INPUT);

    // Each call should run at minimum the Execution MERGE per invocation.
    expect(mockNeoRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── TOUCHED_FILE edges (coding-agent lineage) ────────────────────────────

  it("emits TOUCHED_FILE Cypher with UNWIND MERGE when touchedFilePaths is provided", async () => {
    const touchedFilePaths = ["github:owner/repo:src/a.ts", "github:owner/repo:src/b.ts"];
    await recordExecutionInGraph({ ...BASE_INPUT, touchedFilePaths });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeDefined();
    const cypher = touchedCall![0] as string;
    expect(cypher).toContain("UNWIND");
    expect(cypher).toContain("SourceFile");
    expect(cypher).toContain("TOUCHED_FILE");
    expect(cypher).toContain("MERGE");
  });

  it("passes touchedFilePaths as the $touchedFilePaths param", async () => {
    const touchedFilePaths = ["github:owner/repo:src/util.ts"];
    await recordExecutionInGraph({ ...BASE_INPUT, touchedFilePaths });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeDefined();
    const params = touchedCall![1] as Record<string, unknown>;
    expect(params.touchedFilePaths).toEqual(touchedFilePaths);
  });

  it("sets is_system = true on the TOUCHED_FILE relationship", async () => {
    await recordExecutionInGraph({
      ...BASE_INPUT,
      touchedFilePaths: ["github:owner/repo:src/x.ts"],
    });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeDefined();
    const cypher = touchedCall![0] as string;
    expect(cypher).toContain("r.is_system = true");
  });

  it("skips TOUCHED_FILE edges when touchedFilePaths is not provided", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeUndefined();
  });

  it("skips TOUCHED_FILE edges when touchedFilePaths is empty", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, touchedFilePaths: [] });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeUndefined();
  });

  it("skips TOUCHED_FILE edges when touchedFilePaths is null", async () => {
    await recordExecutionInGraph({ ...BASE_INPUT, touchedFilePaths: null });

    const touchedCall = mockNeoRun.mock.calls.find(([cypher]) =>
      (cypher as string).includes("TOUCHED_FILE"),
    );
    expect(touchedCall).toBeUndefined();
  });

  // ── OXA-2062: orgId bound explicitly on every session.run() call ─────────
  //
  // Every MERGE/MATCH in this module keys on `orgId: $orgId` (the Execution
  // MERGE uses it as part of the idempotency key), but the local params
  // objects previously omitted `orgId` on all five session.run() calls,
  // relying entirely on scopedSession()'s auto-injection. This suite mocks
  // scopedSession() directly (no auto-injection — see the module-level
  // vi.mock above), so this bug was invisible until orgId was bound
  // explicitly on every call.
  it("binds orgId explicitly on every session.run call (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await recordExecutionInGraph({
      ...BASE_INPUT,
      touchedFilePaths: ["github:owner/repo:src/a.ts"],
    });

    expect(mockNeoRun.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of mockNeoRun.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.orgId).toBe(BASE_INPUT.orgId);
    }
  });
});
