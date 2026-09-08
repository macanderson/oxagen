import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getMemoryByIdMock,
  recordCitationMock,
  recordExecutionMock,
  isKnowledgeGraphEnabledMock,
} = vi.hoisted(() => ({
  getMemoryByIdMock: vi.fn(),
  recordCitationMock: vi.fn(),
  recordExecutionMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({
  getMemoryById: getMemoryByIdMock,
  recordCitation: recordCitationMock,
  recordExecution: recordExecutionMock,
}));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: isKnowledgeGraphEnabledMock,
}));

import { agentMemoryCiteHandler } from "./agent.memory.cite";
import { TEST_CTX } from "../test-utils/fixtures";

type CiteInput = Parameters<typeof agentMemoryCiteHandler>[0];

function citation(over: Record<string, unknown> = {}) {
  return {
    memoryId: "m_1",
    influence: "DECISIVE",
    deviated: false,
    ...over,
  } as CiteInput["citations"][number];
}

function input(over: Partial<CiteInput> = {}): CiteInput {
  return {
    executionRef: "exec_ref_1",
    agentId: "agt_1",
    runId: "run_1",
    taskSummary: "summarise the fleet",
    citations: [citation()],
    ...over,
  } as CiteInput;
}

beforeEach(() => {
  getMemoryByIdMock.mockReset();
  recordCitationMock.mockReset();
  recordExecutionMock.mockReset();
  isKnowledgeGraphEnabledMock.mockReset();
  recordExecutionMock.mockResolvedValue({ executionId: "exec_1" });
});

describe("agent.memory.cite handler — knowledge graph disabled", () => {
  it("returns an NA result row per citation and never touches the graph", async () => {
    isKnowledgeGraphEnabledMock.mockReturnValue(false);

    const out = await agentMemoryCiteHandler(
      input({
        citations: [citation(), citation({ memoryId: "m_2" })],
      }),
      TEST_CTX,
    );

    expect(out).toEqual({
      executionId: "",
      recorded: 0,
      results: [
        {
          memoryId: "m_1",
          ok: false,
          citationId: null,
          compliance: "NA",
          error: "Knowledge graph is not configured for this workspace.",
        },
        {
          memoryId: "m_2",
          ok: false,
          citationId: null,
          compliance: "NA",
          error: "Knowledge graph is not configured for this workspace.",
        },
      ],
    });
    expect(recordExecutionMock).not.toHaveBeenCalled();
    expect(recordCitationMock).not.toHaveBeenCalled();
  });
});

describe("agent.memory.cite handler", () => {
  beforeEach(() => {
    isKnowledgeGraphEnabledMock.mockReturnValue(true);
  });

  it("MERGEs the execution and snapshots RULE enforcement at cite time", async () => {
    getMemoryByIdMock.mockResolvedValueOnce({
      memoryClass: "RULE",
      enforcementScore: 90,
      confidenceScore: 55,
    });
    recordCitationMock.mockResolvedValueOnce({ citationId: "cit_1" });

    const out = await agentMemoryCiteHandler(
      input({
        citations: [
          citation({
            deviated: true,
            expectedValue: "a",
            observedValue: "b",
            agentRationale: "because",
          }),
        ],
      }),
      TEST_CTX,
    );

    expect(recordExecutionMock).toHaveBeenCalledWith({
      executionRef: "exec_ref_1",
      agentId: "agt_1",
      runId: "run_1",
      taskSummary: "summarise the fleet",
    });
    // enforcement 90 >= the 70 default threshold with deviated=true ⇒ VIOLATION.
    expect(recordCitationMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      memoryId: "m_1",
      influence: "DECISIVE",
      compliance: "VIOLATION",
      enforcementAtCite: 90,
      confidenceAtCite: 55,
      expectedValue: "a",
      observedValue: "b",
      agentRationale: "because",
    });
    expect(out).toEqual({
      executionId: "exec_1",
      recorded: 1,
      results: [
        {
          memoryId: "m_1",
          ok: true,
          citationId: "cit_1",
          compliance: "VIOLATION",
          error: null,
        },
      ],
    });
  });

  it("derives DISCRETION for a deviation below the enforcement threshold", async () => {
    getMemoryByIdMock.mockResolvedValueOnce({
      memoryClass: "RULE",
      enforcementScore: 10,
      confidenceScore: 40,
    });
    recordCitationMock.mockResolvedValueOnce({ citationId: "cit_2" });

    const out = await agentMemoryCiteHandler(
      input({ citations: [citation({ deviated: true })] }),
      TEST_CTX,
    );

    expect(out.results[0]!.compliance).toBe("DISCRETION");
  });

  it("treats a non-RULE memory as NA — no enforcement score is snapshotted", async () => {
    getMemoryByIdMock.mockResolvedValueOnce({
      memoryClass: "OBSERVATION",
      enforcementScore: 99,
      confidenceScore: 30,
    });
    recordCitationMock.mockResolvedValueOnce({ citationId: "cit_3" });

    const out = await agentMemoryCiteHandler(input(), TEST_CTX);

    expect(recordCitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ enforcementAtCite: null, compliance: "NA" }),
    );
    expect(out.recorded).toBe(1);
  });

  it("fails only the missing memory's row and still records the others", async () => {
    getMemoryByIdMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      memoryClass: "FACT",
      enforcementScore: 100,
      confidenceScore: 100,
    });
    recordCitationMock.mockResolvedValueOnce({ citationId: "cit_4" });

    const out = await agentMemoryCiteHandler(
      input({ citations: [citation(), citation({ memoryId: "m_2" })] }),
      TEST_CTX,
    );

    expect(out.results[0]).toEqual({
      memoryId: "m_1",
      ok: false,
      citationId: null,
      compliance: "NA",
      error: "Memory m_1 not found in this workspace.",
    });
    expect(out.results[1]!.ok).toBe(true);
    expect(out.recorded).toBe(1);
  });

  it("marks the row failed when recordCitation returns no citation id", async () => {
    getMemoryByIdMock.mockResolvedValueOnce({
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      confidenceScore: 1,
    });
    recordCitationMock.mockResolvedValueOnce(null);

    const out = await agentMemoryCiteHandler(input(), TEST_CTX);

    expect(out.results[0]).toEqual({
      memoryId: "m_1",
      ok: false,
      citationId: null,
      compliance: "NA",
      error: "recordCitation returned no citation id",
    });
    expect(out.recorded).toBe(0);
  });

  it("captures a thrown Error message on the failing row without aborting the loop", async () => {
    getMemoryByIdMock
      .mockResolvedValueOnce({
        memoryClass: "OBSERVATION",
        enforcementScore: null,
        confidenceScore: 1,
      })
      .mockResolvedValueOnce({
        memoryClass: "OBSERVATION",
        enforcementScore: null,
        confidenceScore: 1,
      });
    recordCitationMock
      .mockRejectedValueOnce(new Error("neo4j unavailable"))
      .mockResolvedValueOnce({ citationId: "cit_5" });

    const out = await agentMemoryCiteHandler(
      input({ citations: [citation(), citation({ memoryId: "m_2" })] }),
      TEST_CTX,
    );

    expect(out.results[0]!.error).toBe("neo4j unavailable");
    expect(out.results[1]!.ok).toBe(true);
    expect(out.recorded).toBe(1);
  });

  it("falls back to a generic message when a non-Error is thrown", async () => {
    getMemoryByIdMock.mockResolvedValueOnce({
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      confidenceScore: 1,
    });
    recordCitationMock.mockRejectedValueOnce("boom");

    const out = await agentMemoryCiteHandler(input(), TEST_CTX);

    expect(out.results[0]!.error).toBe("Failed to record citation");
  });
});
