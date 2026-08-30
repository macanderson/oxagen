/**
 * Embedding persistence on CodeGraphStore (Group 3). A vector set on a node
 * survives a store round-trip, and the bulk `updateNodeEmbeddings` path writes
 * vectors onto already-persisted nodes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeGraphStore, type CodeGraphStore } from "./store";
import type { FileGraph } from "./store";
import type { CodeNode } from "./types";

let dbPath: string;
let store: CodeGraphStore;

beforeEach(() => {
  dbPath = join(
    mkdtempSync(join(tmpdir(), "oxagen-emb-db-")),
    "code-graph.duckdb",
  );
  store = createCodeGraphStore({ duckdbPath: dbPath });
});
afterEach(async () => {
  await store.close();
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
});

const ROOT = "/repo";

function fileNode(embedding?: number[], provider?: string): CodeNode {
  return {
    id: "F1",
    kind: "file",
    name: "a.ts",
    path: "a.ts",
    range: { start: 1, end: 1 },
    language: "typescript",
    ...(embedding ? { embedding } : {}),
    ...(provider ? { embeddingProvider: provider } : {}),
  };
}

describe("CodeGraphStore embeddings", () => {
  it("round-trips an embedding set on a node at insert time", async () => {
    const fg: FileGraph = {
      contentHash: "h1",
      nodes: [fileNode([0.1, 0.2, 0.3], "openai/text-embedding-3-small")],
      edges: [],
    };
    await store.replaceFile(ROOT, "a.ts", fg);

    const graph = await store.loadGraph(ROOT);
    const loaded = graph.nodes.get("F1");
    expect(loaded?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(loaded?.embeddingProvider).toBe("openai/text-embedding-3-small");
  });

  it("persists vectors via updateNodeEmbeddings after the node exists", async () => {
    await store.replaceFile(ROOT, "a.ts", {
      contentHash: "h1",
      nodes: [fileNode()],
      edges: [],
    });

    await store.updateNodeEmbeddings(
      ROOT,
      new Map([
        ["F1", { vector: [1, 2], provider: "openai/text-embedding-3-small" }],
      ]),
    );

    const graph = await store.loadGraph(ROOT);
    expect(graph.nodes.get("F1")?.embedding).toEqual([1, 2]);
  });

  it("updateNodeEmbeddings is a no-op for an empty map", async () => {
    await store.replaceFile(ROOT, "a.ts", {
      contentHash: "h1",
      nodes: [fileNode()],
      edges: [],
    });
    await store.updateNodeEmbeddings(ROOT, new Map());
    const graph = await store.loadGraph(ROOT);
    expect(graph.nodes.get("F1")?.embedding).toBeUndefined();
  });

  it("leaves embedding undefined when never set", async () => {
    await store.replaceFile(ROOT, "a.ts", {
      contentHash: "h1",
      nodes: [fileNode()],
      edges: [],
    });
    const graph = await store.loadGraph(ROOT);
    expect(graph.nodes.get("F1")?.embedding).toBeUndefined();
    expect(graph.nodes.get("F1")?.embeddingProvider).toBeUndefined();
  });
});
