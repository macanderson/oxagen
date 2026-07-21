/**
 * Domain persistence on CodeGraphStore: `updateNodeDomains` (files + the
 * symbols they contain, which share the file's `path`) and `updateEdgeDomains`
 * (edges, keyed on the declaring file's `file_path`). Both are bulk-stamped
 * from an `inferDomains()` DomainMap during local init — a path absent
 * from the map must stay null, never fabricated.
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
    mkdtempSync(join(tmpdir(), "oxagen-dom-db-")),
    "code-graph.duckdb",
  );
  store = createCodeGraphStore({ duckdbPath: dbPath });
});
afterEach(async () => {
  await store.close();
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
});

const ROOT = "/repo";

function fileNode(id: string, path: string, language = "typescript"): CodeNode {
  return {
    id,
    kind: "file",
    name: path,
    path,
    range: { start: 0, end: 0 },
    language,
  };
}

function symbolNode(id: string, path: string, name: string): CodeNode {
  return {
    id,
    kind: "function",
    name,
    path,
    range: { start: 1, end: 3 },
    language: "typescript",
  };
}

describe("CodeGraphStore domain tagging", () => {
  describe("updateNodeDomains", () => {
    it("stamps domain on a file node whose path matches the map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [fileNode("F1", "a.md", "markdown")],
        edges: [],
      };
      await store.replaceFile(ROOT, "a.md", fg);

      await store.updateNodeDomains(ROOT, new Map([["a.md", "docs"]]));

      const graph = await store.loadGraph(ROOT);
      expect(graph.nodes.get("F1")?.domain).toBe("docs");
    });

    it("propagates a file's domain to the symbols it contains (they share its path)", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [
          fileNode("F1", "billing.ts"),
          symbolNode("S1", "billing.ts", "charge"),
        ],
        edges: [{ source: "F1", target: "S1", type: "contains" }],
      };
      await store.replaceFile(ROOT, "billing.ts", fg);

      await store.updateNodeDomains(ROOT, new Map([["billing.ts", "billing"]]));

      const graph = await store.loadGraph(ROOT);
      expect(graph.nodes.get("F1")?.domain).toBe("billing");
      expect(graph.nodes.get("S1")?.domain).toBe("billing");
    });

    it("leaves a node's domain undefined when its path is absent from the map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [fileNode("F2", "untouched.ts")],
        edges: [],
      };
      await store.replaceFile(ROOT, "untouched.ts", fg);

      await store.updateNodeDomains(ROOT, new Map([["other.ts", "auth"]]));

      const graph = await store.loadGraph(ROOT);
      expect(graph.nodes.get("F2")?.domain).toBeUndefined();
    });

    it("is a no-op for an empty map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [fileNode("F1", "a.md", "markdown")],
        edges: [],
      };
      await store.replaceFile(ROOT, "a.md", fg);

      await store.updateNodeDomains(ROOT, new Map());

      const graph = await store.loadGraph(ROOT);
      expect(graph.nodes.get("F1")?.domain).toBeUndefined();
    });
  });

  describe("updateEdgeDomains", () => {
    it("stamps domain on edges declared by a file whose path matches the map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [
          fileNode("F1", "billing.ts"),
          symbolNode("S1", "billing.ts", "charge"),
        ],
        edges: [{ source: "F1", target: "S1", type: "contains" }],
      };
      await store.replaceFile(ROOT, "billing.ts", fg);

      await store.updateEdgeDomains(ROOT, new Map([["billing.ts", "billing"]]));

      const graph = await store.loadGraph(ROOT);
      const edge = graph.edges.find(
        (e) => e.source === "F1" && e.target === "S1",
      );
      expect(edge?.domain).toBe("billing");
    });

    it("leaves an edge's domain undefined when its declaring file is absent from the map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [
          fileNode("F2", "untouched.ts"),
          symbolNode("S2", "untouched.ts", "fn"),
        ],
        edges: [{ source: "F2", target: "S2", type: "contains" }],
      };
      await store.replaceFile(ROOT, "untouched.ts", fg);

      await store.updateEdgeDomains(ROOT, new Map([["other.ts", "auth"]]));

      const graph = await store.loadGraph(ROOT);
      const edge = graph.edges.find(
        (e) => e.source === "F2" && e.target === "S2",
      );
      expect(edge?.domain).toBeUndefined();
    });

    it("is a no-op for an empty map", async () => {
      const fg: FileGraph = {
        contentHash: "h1",
        nodes: [
          fileNode("F1", "billing.ts"),
          symbolNode("S1", "billing.ts", "charge"),
        ],
        edges: [{ source: "F1", target: "S1", type: "contains" }],
      };
      await store.replaceFile(ROOT, "billing.ts", fg);

      await store.updateEdgeDomains(ROOT, new Map());

      const graph = await store.loadGraph(ROOT);
      const edge = graph.edges.find(
        (e) => e.source === "F1" && e.target === "S1",
      );
      expect(edge?.domain).toBeUndefined();
    });
  });
});
