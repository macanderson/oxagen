import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convertLegacyRow, migrateMemories } from "./neo4j-to-engram";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import type { LegacyMemoryRow } from "./types";
import {
  mapKind,
  mapBody,
  mapNamespace,
  mapProvenance,
  WEIGHT_TO_SALIENCE,
  parseCreatedAt,
} from "./types";

function makeLegacyRow(
  overrides: Partial<LegacyMemoryRow> = {},
): LegacyMemoryRow {
  return {
    id: "neo4j-uuid-123",
    nodeRef: "file:src/main.ts",
    weight: "high",
    kind: "observation",
    lesson: "The main entry point uses Hono framework",
    source: "code_analysis",
    score: 0.8,
    createdAt: "2024-06-15T10:30:00.000Z",
    orgId: "org-1",
    workspaceId: "ws-1",
    ...overrides,
  };
}

describe("Migration type mappings", () => {
  describe("mapKind", () => {
    it("maps 'observation' to 'episodic'", () => {
      expect(mapKind("observation")).toBe("episodic");
    });

    it("maps 'fact' to 'semantic'", () => {
      expect(mapKind("fact")).toBe("semantic");
    });

    it("maps 'rule' to 'procedural'", () => {
      expect(mapKind("rule")).toBe("procedural");
    });

    it("maps 'entity' to 'entity'", () => {
      expect(mapKind("entity")).toBe("entity");
    });

    it("maps 'relationship' to 'edge'", () => {
      expect(mapKind("relationship")).toBe("edge");
    });

    it("defaults unknown kinds to 'episodic'", () => {
      expect(mapKind("unknown_type")).toBe("episodic");
    });

    it("is case-insensitive", () => {
      expect(mapKind("Observation")).toBe("episodic");
      expect(mapKind("FACT")).toBe("semantic");
    });
  });

  describe("mapBody", () => {
    it("wraps semantic kinds in SemanticBody", () => {
      const row = makeLegacyRow({ kind: "fact" });
      const body = mapBody(row, "semantic");
      expect(body).toEqual({
        fact: row.lesson,
        domain: "code", // inferred from source "code_analysis"
      });
    });

    it("wraps non-semantic kinds in EpisodicBody", () => {
      const row = makeLegacyRow({ kind: "observation" });
      const body = mapBody(row, "episodic");
      expect(body).toHaveProperty("event", "observation");
      expect(body).toHaveProperty("payload");
      expect(body).toHaveProperty("outcome", "unknown");
    });
  });

  describe("mapNamespace", () => {
    it("maps orgId and workspaceId", () => {
      const row = makeLegacyRow();
      expect(mapNamespace(row)).toEqual({ org: "org-1", workspace: "ws-1" });
    });
  });

  describe("mapProvenance", () => {
    it("sets migration author and references original ID", () => {
      const row = makeLegacyRow();
      const prov = mapProvenance(row);
      expect(prov.author).toBe("migration:neo4j-to-engram");
      expect(prov.derivedFrom).toContain(row.id);
    });
  });

  describe("WEIGHT_TO_SALIENCE", () => {
    it("maps all weight levels", () => {
      expect(WEIGHT_TO_SALIENCE["low"]).toBe(0.3);
      expect(WEIGHT_TO_SALIENCE["high"]).toBe(0.6);
      expect(WEIGHT_TO_SALIENCE["critical"]).toBe(0.9);
    });
  });

  describe("parseCreatedAt", () => {
    it("parses ISO string to Unix ms", () => {
      const ts = parseCreatedAt("2024-06-15T10:30:00.000Z");
      expect(ts).toBe(new Date("2024-06-15T10:30:00.000Z").getTime());
    });

    it("falls back to Date.now() for unparseable strings", () => {
      const before = Date.now();
      const ts = parseCreatedAt("not-a-date");
      const after = Date.now();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });
});

describe("convertLegacyRow", () => {
  it("converts a valid legacy row to a MemoryRecord", () => {
    const row = makeLegacyRow();
    const record = convertLegacyRow(row);
    expect(record).not.toBeNull();
    expect(record!.id).toHaveLength(64);
    expect(record!.kind).toBe("episodic");
    expect(record!.namespace).toEqual({ org: "org-1", workspace: "ws-1" });
    expect(record!.salience).toBe(0.6); // "high" weight
  });

  it("returns null for rows missing lesson", () => {
    const row = makeLegacyRow({ lesson: "" });
    expect(convertLegacyRow(row)).toBeNull();
  });

  it("returns null for rows missing orgId", () => {
    const row = makeLegacyRow({ orgId: "" });
    expect(convertLegacyRow(row)).toBeNull();
  });

  it("preserves original createdAt timestamp", () => {
    const row = makeLegacyRow({ createdAt: "2024-01-01T00:00:00.000Z" });
    const record = convertLegacyRow(row);
    expect(record!.createdAt).toBe(
      new Date("2024-01-01T00:00:00.000Z").getTime(),
    );
  });

  it("is idempotent (same input → same ID)", () => {
    const row = makeLegacyRow();
    const r1 = convertLegacyRow(row);
    const r2 = convertLegacyRow(row);
    expect(r1!.id).toBe(r2!.id);
  });
});

describe("migrateMemories", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  it("migrates valid rows to the store", async () => {
    const rows = [
      makeLegacyRow({ id: "1", lesson: "fact one" }),
      makeLegacyRow({ id: "2", lesson: "fact two" }),
    ];

    const result = await migrateMemories(rows, store);
    expect(result.processed).toBe(2);
    expect(result.written).toBe(2);
    expect(result.deduplicated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("deduplicates on second run (idempotent)", async () => {
    const rows = [makeLegacyRow({ id: "1", lesson: "fact one" })];

    await migrateMemories(rows, store);
    const result = await migrateMemories(rows, store);

    expect(result.processed).toBe(1);
    expect(result.written).toBe(0);
    expect(result.deduplicated).toBe(1);
  });

  it("tracks errors for invalid rows", async () => {
    const rows = [
      makeLegacyRow({ id: "valid", lesson: "good" }),
      makeLegacyRow({ id: "invalid", lesson: "" }), // empty lesson
    ];

    const result = await migrateMemories(rows, store);
    expect(result.processed).toBe(2);
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.legacyId).toBe("invalid");
  });

  it("respects batch size", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeLegacyRow({ id: `row-${i}`, lesson: `lesson ${i}` }),
    );

    const result = await migrateMemories(rows, store, { batchSize: 2 });
    expect(result.written).toBe(5);
  });

  it("calls onProgress callback", async () => {
    const rows = [
      makeLegacyRow({ id: "1", lesson: "a" }),
      makeLegacyRow({ id: "2", lesson: "b" }),
    ];
    const progress: number[] = [];

    await migrateMemories(rows, store, {
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([1, 2]);
  });
});
