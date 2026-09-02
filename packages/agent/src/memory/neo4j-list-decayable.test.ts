/**
 * Unit tests for the listDecayableMemories function from neo4j.ts.
 *
 * Uses the same scopedSession mock pattern as neo4j.test.ts. Placed in a
 * separate file to keep the mock setup clean and isolated.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { withTestScope } from "@oxagen/tenancy/testing";

const sessionRun = vi.fn();
const sessionClose = vi.fn(async () => undefined);

vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: sessionRun, close: sessionClose }),
}));

import { listDecayableMemories } from "./neo4j";

function fakeRecord(map: Record<string, unknown>) {
  return { get: (k: string) => map[k] };
}

describe("listDecayableMemories", () => {
  beforeEach(() => {
    sessionRun.mockReset();
    sessionClose.mockReset().mockResolvedValue(undefined);
  });

  it("returns empty array when no decayable memories exist", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    const result = await withTestScope(() => listDecayableMemories());
    expect(result).toEqual([]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("queries MATCH on AgentMemory, excluding FACT and memories at/below the decay floor", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() => listDecayableMemories());
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain(
      "MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})",
    );
    expect(cypher).toContain("coalesce(m.status, 'ACTIVE') = 'ACTIVE'");
    expect(cypher).toContain(
      "coalesce(m.memory_class, 'OBSERVATION') <> 'FACT'",
    );
    expect(cypher).toContain("coalesce(m.decay_floor, 5.0)");
  });

  it("returns projected fields mapped from Cypher columns", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_decay_1",
          confidenceScore: 75,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: "2026-06-01T00:00:00Z",
          createdAt: "2026-05-01T00:00:00Z",
          nodeRef: "Function:computeSum",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result).toHaveLength(1);
    const mem = result[0]!;
    expect(mem.id).toBe("m_decay_1");
    expect(mem.confidenceScore).toBe(75);
    expect(mem.halfLifeDays).toBe(30);
    expect(mem.decayFloor).toBe(5);
    expect(mem.lastEvidenceAt).toBe("2026-06-01T00:00:00Z");
    expect(mem.createdAt).toBe("2026-05-01T00:00:00Z");
    expect(mem.nodeRef).toBe("Function:computeSum");
  });

  it("maps multiple records correctly", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          confidenceScore: 90,
          halfLifeDays: 90,
          decayFloor: 5,
          lastEvidenceAt: null,
          createdAt: "2026-04-01T00:00:00Z",
          nodeRef: "Class:Foo",
        }),
        fakeRecord({
          id: "m_2",
          confidenceScore: 40,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: "2026-05-10T00:00:00Z",
          createdAt: "2026-03-15T00:00:00Z",
          nodeRef: "",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("m_1");
    expect(result[1]!.id).toBe("m_2");
    expect(result[1]!.lastEvidenceAt).toBe("2026-05-10T00:00:00Z");
    expect(result[1]!.nodeRef).toBe("");
  });

  it("converts confidenceScore to Number (coalesce)", async () => {
    // neo4j-driver returns numeric types; Number() coerces safely.
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_num",
          confidenceScore: 55,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: null,
          createdAt: "2026-06-10T00:00:00Z",
          nodeRef: "Fn:add",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(typeof result[0]!.confidenceScore).toBe("number");
    expect(result[0]!.confidenceScore).toBeCloseTo(55, 5);
  });

  it("defaults confidenceScore to 100 when the driver returns null", async () => {
    // The Cypher uses coalesce(m.confidence_score, ..., 1.0) * 100.0; when the
    // mock (bypassing the real coalesce) returns null, Number(null ?? 100) = 100.
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_null_conf",
          confidenceScore: null,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: null,
          createdAt: "2026-06-20T00:00:00Z",
          nodeRef: "Fn:noop",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result[0]!.confidenceScore).toBe(100);
  });

  it("coerces null lastEvidenceAt to null in output", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_no_evidence",
          confidenceScore: 80,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: null,
          createdAt: "2026-05-01T00:00:00Z",
          nodeRef: "Module:utils",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result[0]!.lastEvidenceAt).toBeNull();
  });

  it("coerces empty nodeRef string to empty string (not null)", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_empty_ref",
          confidenceScore: 60,
          halfLifeDays: 30,
          decayFloor: 5,
          lastEvidenceAt: null,
          createdAt: "2026-06-01T00:00:00Z",
          nodeRef: "",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result[0]!.nodeRef).toBe("");
  });

  it("closes the session in the finally block even when the query succeeds", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() => listDecayableMemories());
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session in the finally block when the query rejects", async () => {
    sessionRun.mockRejectedValueOnce(new Error("neo4j error"));
    await expect(withTestScope(() => listDecayableMemories())).rejects.toThrow(
      "neo4j error",
    );
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("the Cypher returns id, confidenceScore, halfLifeDays, decayFloor, lastEvidenceAt, createdAt, nodeRef columns", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() => listDecayableMemories());
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("m.id AS id");
    expect(cypher).toContain("AS confidenceScore");
    expect(cypher).toContain("AS halfLifeDays");
    expect(cypher).toContain("AS decayFloor");
    expect(cypher).toContain("AS lastEvidenceAt");
    expect(cypher).toContain("AS createdAt");
    expect(cypher).toContain("AS nodeRef");
  });
});
