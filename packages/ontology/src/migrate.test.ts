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

// How many duplicate KnowledgeNode groups the mocked DB reports. Tests tweak it
// to exercise the no-op path (0) vs. the dedup path (>0).
let dupGroups = 0;
// When set, the merge call rejects with this error (simulates a missing APOC plugin).
let mergeError: Error | null = null;

function makeRecord(values: Record<string, number>) {
  return { get: (key: string) => values[key] };
}

// Stub the client so migrate() never opens a real Neo4j connection. The mock is
// query-aware: the dup-check returns a count record; everything else is a no-op.
const runFn = vi.fn(async (query: string) => {
  if (query.includes(DUP_CHECK)) {
    return { records: dupGroups > 0 ? [makeRecord({ groups: dupGroups, removable: dupGroups })] : [] };
  }
  if (query.includes(MERGE_CALL) && mergeError) {
    throw mergeError;
  }
  return { records: [] };
});
const closeFn = vi.fn(async () => undefined);
vi.mock("./client", () => ({
  session: () => ({ run: runFn, close: closeFn }),
  closeDriver: vi.fn(async () => undefined),
}));

import { migrate } from "./migrate";

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
  });

  it("runs the dup-check then one session.run() per non-empty, non-comment statement", async () => {
    await migrate();
    // 1 dedupe pre-check (no duplicates) + 2 real schema statements.
    expect(runFn).toHaveBeenCalledTimes(3);
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
    const constraintIdx = calls.findIndex((c) => c.includes("CREATE CONSTRAINT a"));
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeLessThan(constraintIdx);
  });

  it("throws an actionable error (mentioning APOC) if the merge fails", async () => {
    dupGroups = 2;
    mergeError = new Error("There is no procedure with the name `apoc.refactor.mergeNodes`");
    await expect(migrate()).rejects.toThrow(/APOC/);
    // Session is still closed on this failure path.
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

describe("splitStatements (via migrate behaviour)", () => {
  beforeEach(() => {
    runFn.mockClear();
    dupGroups = 0;
    mergeError = null;
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
