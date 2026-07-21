import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore, createGraphStore } from "./graph-store";
import type { GraphNode, GraphEdge } from "./graph-store";

const ORG = "test-org";
const WS = "test-ws";

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: overrides.id ?? "node-1",
    labels: overrides.labels ?? ["Entity"],
    displayName: overrides.displayName ?? "Test Node",
    properties: overrides.properties ?? { foo: "bar" },
    isSystem: overrides.isSystem ?? false,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    org: overrides.org ?? ORG,
    workspace: overrides.workspace ?? WS,
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: overrides.id ?? "edge-1",
    sourceId: overrides.sourceId ?? "node-1",
    targetId: overrides.targetId ?? "node-2",
    type: overrides.type ?? "RELATES",
    properties: overrides.properties ?? {},
    inferred: overrides.inferred ?? false,
    org: ORG,
    workspace: WS,
  };
}

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = createGraphStore({ duckdbPath: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  // ── nodes ─────────────────────────────────────────────────────────────────

  it("upserts a node and reads it back by id", async () => {
    const node = makeNode({ id: "n-1", displayName: "Alpha" });
    await store.upsertNodes([node]);

    const got = await store.getNode(ORG, WS, "n-1");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("n-1");
    expect(got!.displayName).toBe("Alpha");
    expect(got!.labels).toEqual(["Entity"]);
    expect(got!.properties).toEqual({ foo: "bar" });
    expect(got!.isSystem).toBe(false);
  });

  it("returns null for a node that does not exist", async () => {
    const got = await store.getNode(ORG, WS, "nonexistent");
    expect(got).toBeNull();
  });

  it("idempotently re-upserts a node — no duplicates", async () => {
    const node = makeNode({ id: "n-dup" });
    await store.upsertNodes([node]);
    await store.upsertNodes([node]);

    const stats = await store.stats(ORG, WS);
    expect(stats.nodeCount).toBe(1);
  });

  it("updates a node on re-upsert with changed fields", async () => {
    await store.upsertNodes([makeNode({ id: "n-upd", displayName: "Before" })]);
    await store.upsertNodes([makeNode({ id: "n-upd", displayName: "After" })]);

    const got = await store.getNode(ORG, WS, "n-upd");
    expect(got!.displayName).toBe("After");
  });

  // ── edges ─────────────────────────────────────────────────────────────────

  it("upserts edges and counts them in stats", async () => {
    await store.upsertNodes([makeNode({ id: "src" }), makeNode({ id: "tgt" })]);
    await store.upsertEdges([
      makeEdge({ id: "e-1", sourceId: "src", targetId: "tgt" }),
    ]);

    const stats = await store.stats(ORG, WS);
    expect(stats.edgeCount).toBe(1);
  });

  it("idempotently re-upserts an edge — no duplicates", async () => {
    const edge = makeEdge({ id: "e-dup" });
    await store.upsertEdges([edge]);
    await store.upsertEdges([edge]);

    const stats = await store.stats(ORG, WS);
    expect(stats.edgeCount).toBe(1);
  });

  it("handles empty node and edge arrays gracefully", async () => {
    await expect(store.upsertNodes([])).resolves.toBeUndefined();
    await expect(store.upsertEdges([])).resolves.toBeUndefined();
  });

  // ── cursor ────────────────────────────────────────────────────────────────

  it("returns null cursor when none is set", async () => {
    const cur = await store.getCursor(ORG, WS);
    expect(cur).toBeNull();
  });

  it("round-trips a cursor through setCursor/getCursor", async () => {
    await store.setCursor(ORG, WS, "2026-01-15T12:00:00Z", 42, 7);
    const cur = await store.getCursor(ORG, WS);

    expect(cur).not.toBeNull();
    expect(cur!.cursor).toBe("2026-01-15T12:00:00Z");
    expect(cur!.nodeCount).toBe(42);
    expect(cur!.edgeCount).toBe(7);
    expect(cur!.org).toBe(ORG);
    expect(cur!.workspace).toBe(WS);
    expect(typeof cur!.syncedAt).toBe("number");
    expect(cur!.syncedAt).toBeGreaterThan(0);
  });

  it("overwrites an existing cursor on repeat setCursor", async () => {
    await store.setCursor(ORG, WS, "old-cursor", 1, 1);
    await store.setCursor(ORG, WS, "new-cursor", 10, 5);
    const cur = await store.getCursor(ORG, WS);
    expect(cur!.cursor).toBe("new-cursor");
    expect(cur!.nodeCount).toBe(10);
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  it("stats returns correct node and edge counts", async () => {
    await store.upsertNodes([
      makeNode({ id: "s1" }),
      makeNode({ id: "s2" }),
      makeNode({ id: "s3" }),
    ]);
    await store.upsertEdges([makeEdge({ id: "se1" }), makeEdge({ id: "se2" })]);

    const stats = await store.stats(ORG, WS);
    expect(stats.nodeCount).toBe(3);
    expect(stats.edgeCount).toBe(2);
    expect(stats.cursor).toBeNull(); // no cursor set yet
    expect(stats.syncedAt).toBeNull();
  });

  it("stats reflects cursor after setCursor", async () => {
    await store.setCursor(ORG, WS, "ts-123", 3, 2);
    const stats = await store.stats(ORG, WS);
    expect(stats.cursor).toBe("ts-123");
    expect(stats.syncedAt).toBeGreaterThan(0);
  });

  it("stats scopes to the correct org+workspace", async () => {
    await store.upsertNodes([makeNode({ id: "x1", org: "other-org" })]);
    const stats = await store.stats(ORG, WS);
    expect(stats.nodeCount).toBe(0);
  });

  // ── searchNodes ───────────────────────────────────────────────────────────

  it("searchNodes matches by displayName substring (case-insensitive)", async () => {
    await store.upsertNodes([
      makeNode({ id: "m1", displayName: "Alpha Corp" }),
      makeNode({ id: "m2", displayName: "Beta Inc" }),
      makeNode({ id: "m3", displayName: "alpha ventures" }),
    ]);

    const results = await store.searchNodes(ORG, WS, "alpha", 10);
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["m1", "m3"]);
  });

  it("searchNodes matches by properties content", async () => {
    await store.upsertNodes([
      makeNode({ id: "p1", properties: { domain: "healthcare" } }),
      makeNode({ id: "p2", properties: { domain: "fintech" } }),
    ]);

    const results = await store.searchNodes(ORG, WS, "healthcare", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("p1");
  });

  it("searchNodes returns empty array when no match", async () => {
    await store.upsertNodes([makeNode({ id: "z1", displayName: "Something" })]);
    const results = await store.searchNodes(ORG, WS, "nothing-matches-xyz", 10);
    expect(results).toHaveLength(0);
  });

  it("searchNodes respects the limit parameter", async () => {
    await store.upsertNodes([
      makeNode({ id: "lim1", displayName: "match one" }),
      makeNode({ id: "lim2", displayName: "match two" }),
      makeNode({ id: "lim3", displayName: "match three" }),
    ]);

    const results = await store.searchNodes(ORG, WS, "match", 2);
    expect(results).toHaveLength(2);
  });

  it("searchNodes treats LIKE wildcards as literals (S-3)", async () => {
    await store.upsertNodes([
      makeNode({ id: "pct1", displayName: "loss is 50% today" }),
      makeNode({ id: "pct2", displayName: "totally unrelated node" }),
    ]);
    // A bare "%" would match everything if not escaped; it must match only the
    // node whose text literally contains "%".
    const results = await store.searchNodes(ORG, WS, "50%", 10);
    expect(results.map((n) => n.id)).toEqual(["pct1"]);
  });

  it("searchNodes treats underscore as a literal, not a single-char wildcard", async () => {
    await store.upsertNodes([
      makeNode({ id: "u1", displayName: "null_pointer" }),
      makeNode({ id: "u2", displayName: "nullXpointer" }),
    ]);
    const results = await store.searchNodes(ORG, WS, "null_pointer", 10);
    expect(results.map((n) => n.id)).toEqual(["u1"]);
  });
});
