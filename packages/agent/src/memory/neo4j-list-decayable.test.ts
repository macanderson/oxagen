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

  it("queries MATCH on AgentMemory with weight != 'critical' and confidence > 0", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() => listDecayableMemories());
    expect(sessionRun).toHaveBeenCalledTimes(1);
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})");
    expect(cypher).toContain("m.weight <> 'critical'");
    expect(cypher).toContain("coalesce(m.confidence, 1.0) > 0");
  });

  it("returns projected fields mapped from Cypher columns", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_decay_1",
          weight: "low",
          confidence: 0.75,
          lastReinforcedAt: "2026-06-01T00:00:00Z",
          createdAt: "2026-05-01T00:00:00Z",
          nodeRef: "Function:computeSum",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result).toHaveLength(1);
    const mem = result[0]!;
    expect(mem.id).toBe("m_decay_1");
    expect(mem.weight).toBe("low");
    expect(mem.confidence).toBe(0.75);
    expect(mem.lastReinforcedAt).toBe("2026-06-01T00:00:00Z");
    expect(mem.createdAt).toBe("2026-05-01T00:00:00Z");
    expect(mem.nodeRef).toBe("Function:computeSum");
  });

  it("maps multiple records correctly", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_1",
          weight: "high",
          confidence: 0.9,
          lastReinforcedAt: null,
          createdAt: "2026-04-01T00:00:00Z",
          nodeRef: "Class:Foo",
        }),
        fakeRecord({
          id: "m_2",
          weight: "low",
          confidence: 0.4,
          lastReinforcedAt: "2026-05-10T00:00:00Z",
          createdAt: "2026-03-15T00:00:00Z",
          nodeRef: "",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("m_1");
    expect(result[1]!.id).toBe("m_2");
    expect(result[1]!.lastReinforcedAt).toBe("2026-05-10T00:00:00Z");
    expect(result[1]!.nodeRef).toBe("");
  });

  it("converts confidence to Number (coalesce)", async () => {
    // neo4j-driver returns numeric types; Number() coerces safely.
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_num",
          weight: "low",
          confidence: 0.55,
          lastReinforcedAt: null,
          createdAt: "2026-06-10T00:00:00Z",
          nodeRef: "Fn:add",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(typeof result[0]!.confidence).toBe("number");
    expect(result[0]!.confidence).toBeCloseTo(0.55, 5);
  });

  it("defaults confidence to 1.0 when the driver returns null", async () => {
    // The Cypher uses coalesce(m.confidence, 1.0); when the driver returns
    // null for a null DB value, Number(null ?? 1.0) = 1.
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_null_conf",
          weight: "high",
          confidence: null,
          lastReinforcedAt: null,
          createdAt: "2026-06-20T00:00:00Z",
          nodeRef: "Fn:noop",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result[0]!.confidence).toBe(1.0);
  });

  it("coerces null lastReinforcedAt to null in output", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_no_reinforce",
          weight: "low",
          confidence: 0.8,
          lastReinforcedAt: null,
          createdAt: "2026-05-01T00:00:00Z",
          nodeRef: "Module:utils",
        }),
      ],
    });

    const result = await withTestScope(() => listDecayableMemories());
    expect(result[0]!.lastReinforcedAt).toBeNull();
  });

  it("coerces empty nodeRef string to empty string (not null)", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [
        fakeRecord({
          id: "m_empty_ref",
          weight: "low",
          confidence: 0.6,
          lastReinforcedAt: null,
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

  it("the Cypher returns id, weight, confidence, lastReinforcedAt, createdAt, nodeRef columns", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });
    await withTestScope(() => listDecayableMemories());
    const cypher = String(sessionRun.mock.calls[0]?.[0] ?? "");
    expect(cypher).toContain("m.id");
    expect(cypher).toContain("m.weight");
    expect(cypher).toContain("m.confidence");
    expect(cypher).toContain("m.lastReinforcedAt");
    expect(cypher).toContain("m.createdAt");
    expect(cypher).toContain("m.nodeRef");
  });
});
