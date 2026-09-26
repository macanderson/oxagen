/**
 * Unit tests for the memory repository's embedding backfill reads and write:
 * findMemoriesMissingEmbedding, readMemoryLessonsMissingEmbedding, and
 * setMemoryEmbeddings. Same scopedSession mock as neo4j-list-decayable.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { withTestScope } from "@oxagen/tenancy/testing";

const sessionRun = vi.fn();
const sessionClose = vi.fn(async () => undefined);

vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: sessionRun, close: sessionClose }),
}));

import {
  findMemoriesMissingEmbedding,
  readMemoryLessonsMissingEmbedding,
  setMemoryEmbeddings,
} from "./neo4j";

function fakeRecord(map: Record<string, unknown>) {
  return { get: (k: string) => map[k] };
}

function cypherOf(call: number): string {
  return String(sessionRun.mock.calls[call]?.[0] ?? "");
}

function paramsOf(call: number): Record<string, unknown> {
  return (sessionRun.mock.calls[call]?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  sessionRun.mockReset();
  sessionClose.mockReset().mockResolvedValue(undefined);
});

describe("findMemoriesMissingEmbedding", () => {
  it("counts memories with no vector and lists up to the limit", async () => {
    sessionRun
      .mockResolvedValueOnce({
        records: [fakeRecord({ missing: 3, excluded: 1 })],
      })
      .mockResolvedValueOnce({
        records: [fakeRecord({ id: "m1" }), fakeRecord({ id: "m2" })],
      });

    const found = await withTestScope(() => findMemoriesMissingEmbedding(2));

    expect(found).toEqual({ missing: 3, excluded: 1, ids: ["m1", "m2"] });
    expect(cypherOf(0)).toContain(
      "MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})",
    );
    expect(cypherOf(0)).toContain("WHERE m.embedding IS NULL");
    expect(cypherOf(1)).toContain("trim(coalesce(m.lesson, '')) <> ''");
    expect(cypherOf(1)).toContain("LIMIT $limit");
    expect(paramsOf(1).limit).toBe(2n);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("only counts when the limit is zero", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ missing: 5, excluded: 0 })],
    });

    const found = await withTestScope(() => findMemoriesMissingEmbedding(0));

    expect(found).toEqual({ missing: 5, excluded: 0, ids: [] });
    expect(sessionRun).toHaveBeenCalledTimes(1);
  });

  it("skips the list when nothing is missing", async () => {
    sessionRun.mockResolvedValueOnce({ records: [] });

    const found = await withTestScope(() => findMemoriesMissingEmbedding(10));

    expect(found).toEqual({ missing: 0, excluded: 0, ids: [] });
    expect(sessionRun).toHaveBeenCalledTimes(1);
  });
});

describe("readMemoryLessonsMissingEmbedding", () => {
  it("returns the lessons of the ids that still have no vector", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ id: "m1", lesson: "Run the migration first" })],
    });

    const lessons = await withTestScope(() =>
      readMemoryLessonsMissingEmbedding(["m1", "m2"]),
    );

    expect(lessons).toEqual([{ id: "m1", lesson: "Run the migration first" }]);
    expect(cypherOf(0)).toContain("m.id IN $ids AND m.embedding IS NULL");
    expect(paramsOf(0).ids).toEqual(["m1", "m2"]);
  });

  it("opens no session for no ids", async () => {
    await expect(readMemoryLessonsMissingEmbedding([])).resolves.toEqual([]);
    expect(sessionRun).not.toHaveBeenCalled();
  });
});

describe("setMemoryEmbeddings", () => {
  it("writes the vector and the model only while the vector is null and the lesson is unchanged", async () => {
    sessionRun.mockResolvedValueOnce({
      records: [fakeRecord({ written: 1 })],
    });
    const rows = [
      { id: "m1", lesson: "Run the migration first", embedding: [0.1, 0.2] },
    ];

    const written = await withTestScope(() =>
      setMemoryEmbeddings(rows, "voyage-3-large"),
    );

    expect(written).toBe(1);
    const cypher = cypherOf(0);
    expect(cypher).toContain("UNWIND $rows AS row");
    expect(cypher).toContain(
      "MATCH (m:AgentMemory {id: row.id, orgId: $orgId, workspaceId: $workspaceId})",
    );
    expect(cypher).toContain(
      "WHERE m.embedding IS NULL AND m.lesson = row.lesson",
    );
    expect(cypher).toContain("m.embedding = row.embedding");
    expect(cypher).toContain("m.embeddingModel = $model");
    expect(paramsOf(0)).toEqual({ rows, model: "voyage-3-large" });
  });

  it("opens no session for no rows", async () => {
    await expect(setMemoryEmbeddings([], "voyage-3-large")).resolves.toBe(0);
    expect(sessionRun).not.toHaveBeenCalled();
  });
});
