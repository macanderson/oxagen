import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Stub node:fs so migrate.ts never touches the real filesystem.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() =>
    [
      "// comment line",
      "CREATE CONSTRAINT a IF NOT EXISTS FOR (n:A) REQUIRE n.id IS UNIQUE;",
      "",
      "CREATE INDEX b IF NOT EXISTS FOR (n:B) ON (n.orgId);",
    ].join("\n"),
  ),
}));

// Stub node:path and node:url — we only need dirname/join/fileURLToPath to
// return deterministic values; the path is passed straight to readFileSync.
vi.mock("node:path", () => ({
  dirname: vi.fn(() => "/stub"),
  join: vi.fn((_dir: string, file: string) => `/stub/${file}`),
}));

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/stub/migrate.ts"),
}));

// The duplicate-publicId pre-check query (returns groups/removable counts) — kept
// in one place so the smart mock and assertions agree on what to match.
const DUP_CHECK = "RETURN count(pid) AS groups, sum(c - 1) AS removable";
const MERGE_CALL = "apoc.refactor.mergeNodes";
// The PascalCase recase: `label` property probe, structural label probe, the
// pure-Cypher property update, and the APOC label rename.
const PROP_PROBE = "DISTINCT n.label";
const LABELS_PROBE = "CALL db.labels()";
const PROP_UPDATE = "SET n.label = $next";
const RENAME_CALL = "apoc.refactor.rename.label";

// How many duplicate KnowledgeNode groups the mocked DB reports. Tests tweak it
// to exercise the no-op path (0) vs. the dedup path (>0).
let dupGroups = 0;
// When set, the merge call rejects with this error (simulates a missing APOC plugin).
let mergeError: Error | null = null;
// Distinct legacy `label` property values the mocked DB reports (recase pass 1).
let legacyLabelProps: string[] = [];
// Structural labels the mocked DB reports from db.labels() (recase pass 2).
let legacyLabels: string[] = [];
// When set, the apoc label rename rejects with this error (missing APOC plugin).
let renameError: Error | null = null;
// The embedding resize (#4148): the vector indexes SHOW INDEXES reports, and
// how many nodes still hold a vector of the old size.
const SHOW_INDEXES = "SHOW INDEXES YIELD name, type, options";
const STALE_COUNT = "RETURN count(n) AS stale";
const CLEAR_STALE = "RETURN count(n) AS done";
let vectorIndexes: { name: string; dimensions: number }[] = [];
let staleVectors = 0;

function makeRecord(values: Record<string, number>) {
  return { get: (key: string) => values[key] };
}

function makeStrRecord(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

// Stub the client so migrate() never opens a real Neo4j connection. The mock is
// query-aware: the count pre-checks return count records; everything else is a no-op.
const runFn = vi.fn(async (query: string) => {
  if (query.includes(DUP_CHECK)) {
    return {
      records:
        dupGroups > 0
          ? [makeRecord({ groups: dupGroups, removable: dupGroups })]
          : [],
    };
  }
  if (query.includes(MERGE_CALL) && mergeError) {
    throw mergeError;
  }
  // PascalCase recase pass 1: distinct `label` property probe (must be checked
  // before the property UPDATE, which also mentions `n.label`).
  if (query.includes(PROP_PROBE)) {
    return {
      records: legacyLabelProps.map((label) => makeStrRecord({ label })),
    };
  }
  // PascalCase recase pass 2: structural label probe.
  if (query.includes(LABELS_PROBE)) {
    return { records: legacyLabels.map((label) => makeStrRecord({ label })) };
  }
  if (query.includes(RENAME_CALL) && renameError) {
    throw renameError;
  }
  if (query.includes(SHOW_INDEXES)) {
    return {
      records: vectorIndexes.map(({ name, dimensions }) => ({
        get: (key: string) =>
          key === "name"
            ? name
            : { indexConfig: { "vector.dimensions": dimensions } },
      })),
    };
  }
  if (query.includes(STALE_COUNT)) {
    return { records: [makeRecord({ stale: staleVectors })] };
  }
  if (query.includes(CLEAR_STALE)) {
    const done = Math.min(staleVectors, 1000);
    staleVectors -= done;
    return { records: [makeRecord({ done })] };
  }
  return { records: [] };
});
const closeFn = vi.fn(async () => undefined);
const sessionArgs = vi.fn();
vi.mock("./client", () => ({
  session: (database?: string | null) => {
    sessionArgs(database);
    return { run: runFn, close: closeFn };
  },
  closeDriver: vi.fn(async () => undefined),
}));
const listOrgDbs = vi.fn(async (): Promise<string[]> => []);
vi.mock("./org-graph", () => ({
  listOrgGraphDatabases: () => listOrgDbs(),
}));

import {
  EMBEDDING_DIMENSIONS,
  migrate,
  migrateEveryGraphDatabase,
  migrateOrgGraphDatabases,
} from "./migrate";

function schemaCalls(): string[] {
  return (runFn.mock.calls as Array<unknown[]>).flatMap((c) =>
    typeof c[0] === "string" ? [(c[0] as string).trim()] : [],
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("migrate() (@oxagen/ontology)", () => {
  beforeEach(() => {
    runFn.mockClear();
    closeFn.mockClear();
    dupGroups = 0;
    mergeError = null;
    legacyLabelProps = [];
    legacyLabels = [];
    renameError = null;
  });

  it("runs the dup-check then one session.run() per non-empty, non-comment statement", async () => {
    await migrate();
    // 1 dedupe pre-check + 2 embedding-size probes + 2 schema statements +
    // 2 PascalCase recase probes.
    expect(runFn).toHaveBeenCalledTimes(7);
  });

  it("passes each Cypher statement as an argument to session.run()", async () => {
    await migrate();
    const calls = schemaCalls();
    expect(calls.some((c) => c.includes("CREATE CONSTRAINT a"))).toBe(true);
    expect(calls.some((c) => c.includes("CREATE INDEX b"))).toBe(true);
  });

  it("runs the dedupe pre-check before any schema statement", async () => {
    await migrate();
    expect(schemaCalls()[0]).toContain(DUP_CHECK);
  });

  it("calls session.close() on success", async () => {
    await migrate();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("calls session.close() even when session.run() throws", async () => {
    runFn.mockRejectedValueOnce(new Error("Neo4j unavailable"));
    await expect(migrate()).rejects.toThrow("Neo4j unavailable");
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("dedupeLegacyKnowledgeNodes (via migrate behaviour)", () => {
  beforeEach(() => {
    runFn.mockClear();
    closeFn.mockClear();
    dupGroups = 0;
    mergeError = null;
    legacyLabelProps = [];
    legacyLabels = [];
    renameError = null;
  });

  it("does NOT issue the apoc merge call when there are no duplicate publicIds", async () => {
    dupGroups = 0;
    await migrate();
    expect(schemaCalls().some((c) => c.includes(MERGE_CALL))).toBe(false);
  });

  it("issues the apoc merge call when duplicate publicIds exist", async () => {
    dupGroups = 4;
    await migrate();
    const calls = schemaCalls();
    expect(calls.some((c) => c.includes(MERGE_CALL))).toBe(true);
    // Merge runs before the schema relabel statements.
    const mergeIdx = calls.findIndex((c) => c.includes(MERGE_CALL));
    const constraintIdx = calls.findIndex((c) =>
      c.includes("CREATE CONSTRAINT a"),
    );
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeLessThan(constraintIdx);
  });

  it("throws an actionable error (mentioning APOC) if the merge fails", async () => {
    dupGroups = 2;
    mergeError = new Error(
      "There is no procedure with the name `apoc.refactor.mergeNodes`",
    );
    await expect(migrate()).rejects.toThrow(/APOC/);
    // Session is still closed on this failure path.
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("pascalCaseDomainLabels (via migrate behaviour)", () => {
  beforeEach(() => {
    runFn.mockClear();
    closeFn.mockClear();
    dupGroups = 0;
    mergeError = null;
    legacyLabelProps = [];
    legacyLabels = [];
    renameError = null;
  });

  it("is a no-op when every label/property is already PascalCase", async () => {
    // Mixed system + already-canonical domain labels — none need recasing.
    legacyLabels = ["GraphNode", "EntityNode", "PullRequest", "User"];
    legacyLabelProps = ["PullRequest", "Issue"];
    await migrate();
    const calls = schemaCalls();
    expect(calls.some((c) => c.includes(RENAME_CALL))).toBe(false);
    expect(calls.some((c) => c.includes(PROP_UPDATE))).toBe(false);
  });

  it("recases lower-/snake-cased `label` properties to PascalCase (pure Cypher)", async () => {
    legacyLabelProps = ["pull_request", "issue"];
    await migrate();
    const calls = schemaCalls();
    const updates = calls.filter((c) => c.includes(PROP_UPDATE));
    // One UPDATE per distinct changed value — and never an APOC call for the
    // property pass (must work on community Neo4j).
    expect(updates.length).toBe(2);
  });

  it("issues an APOC label rename only for labels that actually change", async () => {
    // Two need recasing (pull_request, issue); two are already canonical.
    legacyLabels = ["pull_request", "issue", "GraphNode", "User"];
    await migrate();
    const renames = schemaCalls().filter((c) => c.includes(RENAME_CALL));
    expect(renames.length).toBe(2);
  });

  it("does NOT issue the apoc rename when all labels are already canonical", async () => {
    legacyLabels = ["GraphNode", "EntityNode", "Execution"];
    await migrate();
    expect(schemaCalls().some((c) => c.includes(RENAME_CALL))).toBe(false);
  });

  it("runs the recase AFTER the schema statements (back-fill, not a prerequisite)", async () => {
    legacyLabels = ["pull_request"];
    await migrate();
    const calls = schemaCalls();
    const renameIdx = calls.findIndex((c) => c.includes(RENAME_CALL));
    const constraintIdx = calls.findIndex((c) =>
      c.includes("CREATE CONSTRAINT a"),
    );
    expect(renameIdx).toBeGreaterThan(constraintIdx);
  });

  it("throws an actionable error (mentioning APOC) if the label rename fails", async () => {
    legacyLabels = ["pull_request"];
    renameError = new Error(
      "There is no procedure with the name `apoc.refactor.rename.label`",
    );
    await expect(migrate()).rejects.toThrow(/APOC/);
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("resizeEmbeddingIndexes (via migrate behaviour, #4148)", () => {
  beforeEach(() => {
    runFn.mockClear();
    closeFn.mockClear();
    dupGroups = 0;
    mergeError = null;
    legacyLabelProps = [];
    legacyLabels = [];
    renameError = null;
    vectorIndexes = [];
    staleVectors = 0;
  });

  it("targets 1,024 dimensions, the size voyage-4-large returns", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it("drops an embedding index of another size and keeps one of the current size", async () => {
    vectorIndexes = [
      { name: "memory_embedding_index", dimensions: 1536 },
      { name: "graph_node_embedding_index", dimensions: 1024 },
    ];
    await migrate();
    const calls = schemaCalls();
    expect(calls).toContain("DROP INDEX memory_embedding_index IF EXISTS");
    expect(calls.some((c) => c.includes("DROP INDEX graph_node"))).toBe(false);
  });

  it("leaves a vector index it does not own alone, whatever its size", async () => {
    vectorIndexes = [{ name: "customer_vector_index", dimensions: 1536 }];
    await migrate();
    expect(schemaCalls().some((c) => c.includes("DROP INDEX"))).toBe(false);
  });

  it("drops before schema.cypher runs, so the create recreates the index", async () => {
    vectorIndexes = [{ name: "entity_node_embedding_index", dimensions: 1536 }];
    await migrate();
    const calls = schemaCalls();
    const drop = calls.indexOf("DROP INDEX entity_node_embedding_index IF EXISTS");
    const create = calls.findIndex((c) => c.includes("CREATE CONSTRAINT a"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(create);
  });

  it("clears vectors of the old size in batches until none remain", async () => {
    staleVectors = 2500;
    await migrate();
    const clears = schemaCalls().filter((c) => c.includes(CLEAR_STALE));
    // 1,000 + 1,000 + 500, then one pass that finds nothing.
    expect(clears).toHaveLength(4);
    expect(staleVectors).toBe(0);
  });

  it("clears the model with the vector, so the node reads as never embedded", async () => {
    staleVectors = 1;
    await migrate();
    const clear = schemaCalls().find((c) => c.includes(CLEAR_STALE));
    expect(clear).toContain("SET n.embedding = null");
    expect(clear).toContain("REMOVE n.embeddingModel");
  });

  it("clears nothing when every vector is the current size", async () => {
    await migrate();
    expect(schemaCalls().some((c) => c.includes(CLEAR_STALE))).toBe(false);
  });
});

describe("splitStatements (via migrate behaviour)", () => {
  beforeEach(() => {
    runFn.mockClear();
    dupGroups = 0;
    mergeError = null;
    legacyLabelProps = [];
    legacyLabels = [];
    renameError = null;
  });

  it("strips comment-only lines before splitting", async () => {
    await migrate();
    for (const stmt of schemaCalls()) {
      expect(stmt).not.toMatch(/^\s*\/\//);
    }
  });

  it("produces no empty statements", async () => {
    await migrate();
    for (const stmt of schemaCalls()) {
      expect(stmt.length).toBeGreaterThan(0);
    }
  });
});

describe("migrate() per organisation database (ADR-098)", () => {
  beforeEach(() => {
    runFn.mockClear();
    sessionArgs.mockClear();
    listOrgDbs.mockReset();
  });

  it("opens the pooled database when no name is given", async () => {
    await migrate();
    expect(sessionArgs).toHaveBeenCalledWith(undefined);
  });

  it("opens the named database when one is given", async () => {
    await migrate("org-acme");
    expect(sessionArgs).toHaveBeenCalledWith("org-acme");
  });

  it("migrates every organisation database the engine reports", async () => {
    listOrgDbs.mockResolvedValue(["org-ab", "org-cd"]);
    await expect(migrateOrgGraphDatabases()).resolves.toEqual([
      "org-ab",
      "org-cd",
    ]);
    expect(sessionArgs.mock.calls.map((c) => c[0])).toEqual([
      "org-ab",
      "org-cd",
    ]);
  });

  it("is a no-op on Community Edition, which reports none", async () => {
    listOrgDbs.mockResolvedValue([]);
    await expect(migrateOrgGraphDatabases()).resolves.toEqual([]);
    expect(sessionArgs).not.toHaveBeenCalled();
  });

  // The deploy-time entry. `tools/scripts/db-migrate.ts` imports this module
  // rather than running it, so the per-organisation pass must live in an
  // exported function that the aggregate migrator calls — a pass that ran only
  // under the direct-run guard never ran on a deploy.
  it("migrateEveryGraphDatabase migrates the pooled database first, then every organisation database", async () => {
    listOrgDbs.mockResolvedValue(["org-ab", "org-cd"]);
    await expect(migrateEveryGraphDatabase()).resolves.toEqual({
      orgDatabases: ["org-ab", "org-cd"],
    });
    expect(sessionArgs.mock.calls.map((c) => c[0])).toEqual([
      undefined,
      "org-ab",
      "org-cd",
    ]);
  });

  it("migrateEveryGraphDatabase still migrates the pooled database when no organisation database exists", async () => {
    listOrgDbs.mockResolvedValue([]);
    await expect(migrateEveryGraphDatabase()).resolves.toEqual({
      orgDatabases: [],
    });
    expect(sessionArgs.mock.calls.map((c) => c[0])).toEqual([undefined]);
  });

  it("the aggregate migrator calls the deploy-time entry, not the pooled-only migrate()", async () => {
    // Read as text rather than imported: the script runs `main()` on import
    // and exits the process. The assertion is on the import binding, which is
    // the seam the P1 finding named.
    const { readFileSync: realRead } =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const { resolve: realResolve } =
      await vi.importActual<typeof import("node:path")>("node:path");
    const script = realRead(
      realResolve(__dirname, "../../../tools/scripts/db-migrate.ts"),
      "utf8",
    );
    expect(script).toMatch(
      /import \{ migrateEveryGraphDatabase \} from "@oxagen\/ontology\/migrate"/,
    );
    expect(script).toMatch(/await migrateEveryGraphDatabase\(\)/);
    expect(script).not.toMatch(/migrate as migrateNeo4j/);
  });
});
