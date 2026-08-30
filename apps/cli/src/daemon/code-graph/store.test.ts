/**
 * CodeGraphStore + incremental persistence tests.
 *
 * Uses a real on-disk temp DuckDB file (not `:memory:`) so a fresh store opened
 * on the same path sees the persisted graph — the whole point of the store
 * (cold-start reload). Each test gets its own temp repo + db file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodeGraphStore,
  computeEdgeId,
  hashContent,
  type CodeGraphStore,
} from "./store";
import { buildAndPersistCodeGraph, buildCodeGraph } from "./builder";

let repo: string;
let dbPath: string;
let store: CodeGraphStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "oxagen-cg-repo-"));
  dbPath = join(
    mkdtempSync(join(tmpdir(), "oxagen-cg-db-")),
    "code-graph.duckdb",
  );
  store = createCodeGraphStore({ duckdbPath: dbPath });
});

afterEach(async () => {
  await store.close();
  rmSync(repo, { recursive: true, force: true });
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
});

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("pure helpers", () => {
  it("computeEdgeId is deterministic and order-sensitive", () => {
    expect(computeEdgeId("a", "b", "imports")).toBe(
      computeEdgeId("a", "b", "imports"),
    );
    expect(computeEdgeId("a", "b", "imports")).not.toBe(
      computeEdgeId("b", "a", "imports"),
    );
    expect(computeEdgeId("a", "b", "imports")).not.toBe(
      computeEdgeId("a", "b", "contains"),
    );
  });

  it("hashContent changes with content", () => {
    expect(hashContent("x")).toBe(hashContent("x"));
    expect(hashContent("x")).not.toBe(hashContent("y"));
  });
});

describe("buildAndPersistCodeGraph", () => {
  it("indexes files + symbols + edges and persists them", async () => {
    write("a.ts", "export function foo() { return 1; }\nexport class Bar {}\n");
    write(
      "b.ts",
      'import { foo } from "./a";\nexport function baz() { return foo(); }\n',
    );

    const delta = await buildAndPersistCodeGraph(repo, store);
    expect(delta).toEqual({ indexed: 2, skipped: 0, removed: 0 });

    const stats = await store.stats(repo);
    expect(stats.files).toBe(2);
    expect(stats.symbols).toBe(3); // foo, Bar, baz
    // 3 `contains` (a→foo, a→Bar, b→baz) + 1 resolved `imports` (b→a)
    expect(stats.edges).toBe(4);
  });

  it("re-running with no changes re-parses nothing (incremental skip)", async () => {
    write("a.ts", "export function foo() {}\n");
    await buildAndPersistCodeGraph(repo, store);

    const second = await buildAndPersistCodeGraph(repo, store);
    expect(second).toEqual({ indexed: 0, skipped: 1, removed: 0 });
  });

  it("re-parses only the changed file", async () => {
    write("a.ts", "export function foo() {}\n");
    write("b.ts", "export function bar() {}\n");
    await buildAndPersistCodeGraph(repo, store);

    write("b.ts", "export function bar() {}\nexport function extra() {}\n");
    const delta = await buildAndPersistCodeGraph(repo, store);
    expect(delta).toEqual({ indexed: 1, skipped: 1, removed: 0 });

    const stats = await store.stats(repo);
    expect(stats.symbols).toBe(3); // foo, bar, extra
  });

  it("drops files that no longer exist on disk", async () => {
    write("a.ts", "export function foo() {}\n");
    write("b.ts", "export function bar() {}\n");
    await buildAndPersistCodeGraph(repo, store);

    rmSync(join(repo, "a.ts"));
    const delta = await buildAndPersistCodeGraph(repo, store);
    expect(delta.removed).toBe(1);

    const stats = await store.stats(repo);
    expect(stats.files).toBe(1);
    expect((await store.indexedFiles(repo)).sort()).toEqual(["b.ts"]);
  });

  it("indexes .md files as file nodes (docs carry an embedding + domain too)", async () => {
    write("README.md", "# Title\n\nSome docs content.\n");

    const delta = await buildAndPersistCodeGraph(repo, store);
    expect(delta).toEqual({ indexed: 1, skipped: 0, removed: 0 });

    const graph = await store.loadGraph(repo);
    const node = [...graph.nodes.values()].find((n) => n.path === "README.md");
    expect(node?.kind).toBe("file");
    expect(node?.language).toBe("markdown");

    // Headings are parsed (see @oxagen/code-graph markdown.ts) but intentionally
    // not turned into symbol nodes — only the file node is indexed.
    const stats = await store.stats(repo);
    expect(stats.files).toBe(1);
    expect(stats.symbols).toBe(0);
  });

  it("survives a cold reopen — graph reloads from disk", async () => {
    write("a.ts", "export function foo() {}\n");
    await buildAndPersistCodeGraph(repo, store);
    await store.close();

    // Re-open the same DB file (simulates a new process / daemon start).
    store = createCodeGraphStore({ duckdbPath: dbPath });
    const graph = await store.loadGraph(repo);
    const names = [...graph.nodes.values()].map((n) => n.name).sort();
    expect(names).toEqual(["a.ts", "foo"]);
    // The previously-indexed file is skipped on the next incremental build.
    expect((await buildAndPersistCodeGraph(repo, store)).skipped).toBe(1);
  });

  it("reports real per-file progress via onProgress — used by oxagen init's animation", async () => {
    write("a.ts", "export function foo() {}\n");
    write("b.ts", "export function bar() {}\n");
    write("c.ts", "export function baz() {}\n");

    const ticks: Array<{ done: number; total: number }> = [];
    await buildAndPersistCodeGraph(repo, store, (done, total) => {
      ticks.push({ done, total });
    });

    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => t.total === 3)).toBe(true);
    expect(ticks.map((t) => t.done)).toEqual([1, 2, 3]); // monotonic, one per file
  });

  it("still reports 0 total files gracefully with an empty repo", async () => {
    const ticks: Array<{ done: number; total: number }> = [];
    await buildAndPersistCodeGraph(repo, store, (done, total) => {
      ticks.push({ done, total });
    });
    expect(ticks).toEqual([]);
  });
});

describe("buildCodeGraph (in-memory fallback) onProgress", () => {
  it("reports real per-file progress for the in-memory build path too", async () => {
    write("a.ts", "export function foo() {}\n");
    write("b.ts", "export function bar() {}\n");

    const ticks: Array<{ done: number; total: number }> = [];
    const graph = await buildCodeGraph(repo, (done, total) => {
      ticks.push({ done, total });
    });

    expect(graph.nodes.size).toBeGreaterThan(0);
    expect(ticks).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it("behaves identically when onProgress is omitted", async () => {
    write("a.ts", "export function foo() {}\n");
    const graph = await buildCodeGraph(repo);
    expect(graph.nodes.size).toBeGreaterThan(0);
  });
});

describe("loadGraph + replaceFile", () => {
  it("round-trips nodes and edges into a queryable CodeGraph", async () => {
    write("a.ts", "export function foo() {}\nexport class Bar {}\n");
    await buildAndPersistCodeGraph(repo, store);

    const graph = await store.loadGraph(repo);
    const file = [...graph.nodes.values()].find((n) => n.kind === "file");
    expect(file?.path).toBe("a.ts");
    const containsTargets = graph.edges.filter(
      (e) => e.type === "contains",
    ).length;
    expect(containsTargets).toBe(2);
  });

  it("fileHash returns null before indexing, the hash after", async () => {
    expect(await store.fileHash(repo, "a.ts")).toBeNull();
    write("a.ts", "export function foo() {}\n");
    await buildAndPersistCodeGraph(repo, store);
    expect(await store.fileHash(repo, "a.ts")).not.toBeNull();
  });
});
