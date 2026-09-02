import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so all mock fns exist when the vi.mock factories run.
const mocks = vi.hoisted(() => ({
  recordExecutionMock: vi.fn(),
  recordMentionCitationMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({
  recordExecution: mocks.recordExecutionMock,
  recordMentionCitation: mocks.recordMentionCitationMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));

import { referenceCiteHandler } from "./reference.cite";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("reference.cite handler", () => {
  beforeEach(() => {
    mocks.recordExecutionMock.mockReset();
    mocks.recordMentionCitationMock.mockReset();
    mocks.isKnowledgeGraphEnabledMock.mockReset();
    // Sensible defaults: KG enabled, execution MERGEd, citation written.
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
    mocks.recordExecutionMock.mockResolvedValue({ executionId: "exec_1" });
    mocks.recordMentionCitationMock.mockImplementation(
      async ({ nodePublicId }: { nodePublicId: string }) => ({
        citationId: `cit_${nodePublicId}`,
      }),
    );
  });

  it("when the knowledge graph is disabled, marks every reference failed and records nothing", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);

    const res = await referenceCiteHandler(
      {
        executionRef: "msg_1",
        references: [{ nodeId: "n1" }, { nodeId: "n2" }],
      },
      CTX,
    );

    expect(res.executionId).toBe("");
    expect(res.recorded).toBe(0);
    expect(res.results).toHaveLength(2);
    expect(
      res.results.every((r) => r.ok === false && r.citationId === null),
    ).toBe(true);
    expect(
      res.results.every(
        (r) => typeof r.error === "string" && r.error.length > 0,
      ),
    ).toBe(true);
    // No graph writes attempted.
    expect(mocks.recordExecutionMock).not.toHaveBeenCalled();
    expect(mocks.recordMentionCitationMock).not.toHaveBeenCalled();
  });

  it("records the execution once and one citation per reference on the happy path", async () => {
    const res = await referenceCiteHandler(
      {
        executionRef: "msg_1",
        agentId: "agt_1",
        taskSummary: "chat turn",
        references: [{ nodeId: "n1" }, { nodeId: "n2" }],
      },
      CTX,
    );

    expect(mocks.recordExecutionMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRef: "msg_1",
        agentId: "agt_1",
        taskSummary: "chat turn",
      }),
    );
    expect(mocks.recordMentionCitationMock).toHaveBeenCalledTimes(2);
    expect(mocks.recordMentionCitationMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodePublicId: "n1",
    });
    expect(res.executionId).toBe("exec_1");
    expect(res.recorded).toBe(2);
    expect(res.results).toEqual([
      { nodeId: "n1", ok: true, citationId: "cit_n1", error: null },
      { nodeId: "n2", ok: true, citationId: "cit_n2", error: null },
    ]);
  });

  it("marks a not-found node failed while the rest succeed", async () => {
    mocks.recordMentionCitationMock.mockImplementation(
      async ({ nodePublicId }: { nodePublicId: string }) =>
        nodePublicId === "missing"
          ? null
          : { citationId: `cit_${nodePublicId}` },
    );

    const res = await referenceCiteHandler(
      {
        executionRef: "msg_1",
        references: [{ nodeId: "n1" }, { nodeId: "missing" }],
      },
      CTX,
    );

    expect(res.recorded).toBe(1);
    const ok = res.results.find((r) => r.nodeId === "n1");
    const miss = res.results.find((r) => r.nodeId === "missing");
    expect(ok).toEqual({
      nodeId: "n1",
      ok: true,
      citationId: "cit_n1",
      error: null,
    });
    expect(miss?.ok).toBe(false);
    expect(miss?.citationId).toBeNull();
    expect(miss?.error).toContain("not found");
  });

  it("captures a citation-write throw as an error row without failing the whole handler", async () => {
    mocks.recordMentionCitationMock.mockImplementation(
      async ({ nodePublicId }: { nodePublicId: string }) => {
        if (nodePublicId === "boom") throw new Error("Bolt write failed");
        return { citationId: `cit_${nodePublicId}` };
      },
    );

    const res = await referenceCiteHandler(
      {
        executionRef: "msg_1",
        references: [{ nodeId: "boom" }, { nodeId: "n2" }],
      },
      CTX,
    );

    expect(res.recorded).toBe(1);
    const boom = res.results.find((r) => r.nodeId === "boom");
    expect(boom?.ok).toBe(false);
    expect(boom?.citationId).toBeNull();
    expect(boom?.error).toBe("Bolt write failed");
    const good = res.results.find((r) => r.nodeId === "n2");
    expect(good?.ok).toBe(true);
    expect(good?.citationId).toBe("cit_n2");
  });
});
