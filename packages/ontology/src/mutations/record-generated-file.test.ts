import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { recordGeneratedFileInGraph, type RecordGeneratedFileInput } from "./record-generated-file";

const mockScopedSession = vi.mocked(scopedSession);

const BASE_INPUT: RecordGeneratedFileInput = {
  publicId: "gen_unit001",
  orgId: "org-test",
  workspaceId: "ws-test",
  kind: "document",
  mimeType: "text/markdown",
  model: "local",
  displayName: "USS Nautilus: The First Nuclear Submarine",
  prompt: "Generate markdown: USS Nautilus: The First Nuclear Submarine",
  conversationId: "conv-1",
  messageId: "msg-1",
  summary: "USS Nautilus: The First Nuclear Submarine\nThe world's first nuclear submarine…",
};

const FAKE_EMBEDDING = new Array(1536).fill(0.1);

describe("recordGeneratedFileInGraph", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  it("MERGEs a :GeneratedFile node anchored as :GraphNode", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":GeneratedFile");
    expect(cypher).toContain("f:GraphNode");
  });

  it("sets is_system = true in both ON CREATE and ON MATCH", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    const matches = cypher.match(/is_system\s*=\s*true/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("keys the node on publicId + orgId and sets a human displayName", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("publicId: $publicId");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.publicId).toBe("gen_unit001");
    expect(params.displayName).toBe("USS Nautilus: The First Nuclear Submarine");
  });

  it("stores kind/mimeType/content in the properties bag for snippets", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    const parsed = JSON.parse(params.properties as string) as Record<string, unknown>;
    expect(parsed.kind).toBe("document");
    expect(parsed.mimeType).toBe("text/markdown");
    expect(typeof parsed.content).toBe("string"); // the embed/snippet source
  });

  it("includes the FOREACH embedding guard and passes the vector", async () => {
    await recordGeneratedFileInGraph({ ...BASE_INPUT, embedding: FAKE_EMBEDDING });
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("FOREACH");
    expect(cypher).toContain("$embedding");
    expect(cypher).toContain("f.embeddingUpdatedAt");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.embedding).toEqual(FAKE_EMBEDDING);
  });

  it("passes embedding = null when omitted (never overwrites an existing vector)", async () => {
    await recordGeneratedFileInGraph({ ...BASE_INPUT, embedding: undefined });
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.embedding).toBeNull();
  });

  it("links the producing execution via (:Execution)-[:PRODUCED]->(:GeneratedFile) when messageId is set", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    const edgeCall = mockNeoRun.mock.calls.find(([c]) => (c as string).includes("PRODUCED"));
    expect(edgeCall).toBeDefined();
    const cypher = edgeCall![0] as string;
    expect(cypher).toContain(":Execution");
    expect(cypher).toContain("e.originType = 'chat'");
    expect(cypher).toContain("e.originId = $messageId");
    expect(cypher).toContain("r.is_system = true");
  });

  it("skips the lineage edge when there is no messageId", async () => {
    await recordGeneratedFileInGraph({ ...BASE_INPUT, messageId: null });
    const edgeCall = mockNeoRun.mock.calls.find(([c]) => (c as string).includes("PRODUCED"));
    expect(edgeCall).toBeUndefined();
  });

  it("always closes the session even if run() throws", async () => {
    mockNeoRun.mockRejectedValueOnce(new Error("Neo4j unreachable"));
    await expect(recordGeneratedFileInGraph(BASE_INPUT)).rejects.toThrow("Neo4j unreachable");
    expect(mockNeoClose).toHaveBeenCalledOnce();
  });

  it("is idempotent — re-driving the same publicId succeeds", async () => {
    await recordGeneratedFileInGraph(BASE_INPUT);
    await recordGeneratedFileInGraph(BASE_INPUT);
    expect(mockNeoRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
