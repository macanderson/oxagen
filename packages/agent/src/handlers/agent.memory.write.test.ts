import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  writeMemoryMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

mocks.embedTextMock.mockImplementation(async () => new Array(1536).fill(0.1));
mocks.writeMemoryMock.mockImplementation(async () => ({
  memoryId: "m_new",
  edgesCreated: 0,
}));
// Default: KG enabled so existing tests are unaffected.
mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);

vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../memory/neo4j", () => ({ writeMemory: mocks.writeMemoryMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));

import { agentMemoryWriteHandler } from "./agent.memory.write";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.memory.write handler", () => {
  beforeEach(() => {
    mocks.embedTextMock.mockClear();
    mocks.writeMemoryMock.mockClear();
    mocks.isKnowledgeGraphEnabledMock.mockClear();
    // Default back to enabled for each test.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
    mocks.writeMemoryMock.mockImplementation(async () => ({
      memoryId: "m_new",
      edgesCreated: 0,
    }));
  });

  it("forwards inputs to writeMemory (defaulted OBSERVATION) and returns memoryId + nodeRef", async () => {
    const res = await agentMemoryWriteHandler(
      {
        nodeRef: "Function:foo",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "do not rerun migrations",
        source: "feature",
      },
      CTX,
    );
    expect(mocks.embedTextMock).toHaveBeenCalledWith(
      "do not rerun migrations",
      {
        telemetry: {
          orgId: "org_1",
          workspaceId: "ws_1",
          surface: "runner",
          executionStepId: "req_1",
        },
      },
    );
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(1);
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // orgId/workspaceId are no longer passed directly — scopedSession reads them from the ALS scope
    expect(arg.orgId).toBeUndefined();
    expect(arg.workspaceId).toBeUndefined();
    expect(arg.nodeRef).toBe("Function:foo");
    expect(arg.memoryClass).toBe("OBSERVATION");
    expect(arg.memoryKind).toBe("constraint");
    expect(arg.enforcementScore).toBeNull();
    expect(arg.createdByKind).toBe("AGENT");
    expect(arg.createdById).toBe("feature");
    expect(res.memoryId).toBe("m_new");
    expect(res.nodeRef).toBe("Function:foo");
    expect(res.edgesCreated).toBe(0);
  });

  it("passes a pinned RULE's enforcementScore through to writeMemory", async () => {
    const res = await agentMemoryWriteHandler(
      {
        nodeRef: "Function:foo",
        memoryClass: "RULE",
        memoryKind: "constraint",
        enforcementScore: 80,
        lesson: "never run migrations twice",
        source: "feature",
      },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.memoryClass).toBe("RULE");
    expect(arg.enforcementScore).toBe(80);
    expect(res.memoryId).toBe("m_new");
  });

  it("throws when memoryClass RULE has no enforcementScore (invariant enforced before writeMemory)", async () => {
    await expect(
      agentMemoryWriteHandler(
        {
          nodeRef: "Function:foo",
          memoryClass: "RULE",
          memoryKind: "constraint",
          lesson: "no score given",
          source: "feature",
        },
        CTX,
      ),
    ).rejects.toThrow("RULE requires enforcement_score");
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
  });

  it("throws when memoryClass FACT is pinned (write has no confirmedBy fields; only promote can reach FACT)", async () => {
    await expect(
      agentMemoryWriteHandler(
        {
          nodeRef: "Function:foo",
          memoryClass: "FACT",
          memoryKind: "constraint",
          lesson: "a supposed fact",
          source: "feature",
        },
        CTX,
      ),
    ).rejects.toThrow("confirmed_by_kind = USER");
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
  });

  it("passes relatedNodeIds to writeMemory and surfaces edgesCreated", async () => {
    mocks.writeMemoryMock.mockImplementationOnce(async () => ({
      memoryId: "m_rel",
      edgesCreated: 3,
    }));
    const res = await agentMemoryWriteHandler(
      {
        nodeRef: "Function:baz",
        memoryClass: "OBSERVATION",
        memoryKind: "constraint",
        lesson: "always close sessions",
        source: "feature",
        relatedNodeIds: ["kn_1", "kn_2", "kn_3"],
      },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.relatedNodeIds).toEqual(["kn_1", "kn_2", "kn_3"]);
    expect(res.memoryId).toBe("m_rel");
    expect(res.edgesCreated).toBe(3);
  });

  it("no-ops when knowledge graph is disabled — returns valid output without touching Neo4j or embeddings", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);

    const res = await agentMemoryWriteHandler(
      {
        nodeRef: "Function:bar",
        memoryClass: "RULE",
        memoryKind: "bug-root-cause",
        enforcementScore: 95,
        lesson: "always close sessions",
        source: "fix",
      },
      CTX,
    );

    // Output must be a valid AgentMemoryWriteOutput (memoryId + nodeRef + edgesCreated).
    expect(typeof res.memoryId).toBe("string");
    expect(res.nodeRef).toBe("Function:bar");
    expect(res.edgesCreated).toBe(0);
    // Neither the embedding model nor Neo4j must have been called.
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
  });
});
