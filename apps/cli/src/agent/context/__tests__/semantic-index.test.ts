/**
 * ensureFileEmbeddings — markdown files get the content-aware renderer
 * (renderMarkdownFileText: chunked, no symbol-name list to lean on) instead of
 * renderFileText's generic head-slice. Verified by capturing the exact text
 * handed to the embedding client, since that's the one observable surface of
 * "which renderer fired."
 *
 * The offline (no embedding client) degrade path is generic — it short-circuits
 * before any file is even inspected — and already covered by
 * apps/cli/src/agent/__tests__/code-graph.test.ts's
 * "degrades gracefully (never throws) when no embedding client is available".
 */
import { describe, it, expect } from "vitest";
import { ensureFileEmbeddings } from "../semantic-index.js";
import type { EmbeddingClient } from "../embedding.js";
import type { CodeGraph, CodeNode } from "../../../daemon/code-graph/types.js";

function makeGraph(nodes: CodeNode[]): CodeGraph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges: [] };
}

/** A client that records every text it was asked to embed (order-preserving). */
function fakeClient(): EmbeddingClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    providerId: "fake-v1",
    dimensions: 2,
    calls,
    async embed(text) {
      calls.push(text);
      return [1, 0];
    },
    async embedBatch(texts) {
      calls.push(...texts);
      return texts.map(() => [1, 0]);
    },
  };
}

describe("ensureFileEmbeddings — markdown content embedding", () => {
  it("embeds a markdown file's actual content, including text past the generic 1500-char head slice", async () => {
    const filler = "Lorem ipsum dolor sit amet. ".repeat(80); // > 1500 chars
    const marker = "UNIQUE_DOC_MARKER_PAST_THE_HEAD";
    const content = `# Guide\n\n${filler}\n\n${marker}\n\nmore text after the marker.`;
    expect(filler.length).toBeGreaterThan(1500);

    const node: CodeNode = {
      id: "F1",
      kind: "file",
      name: "guide.md",
      path: "guide.md",
      range: { start: 0, end: 0 },
      language: "markdown",
    };
    const client = fakeClient();

    const result = await ensureFileEmbeddings({
      graph: makeGraph([node]),
      root: "/repo",
      client,
      store: null,
      readFileText: async () => content,
    });

    expect(result.embedded).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toContain(marker);
  });

  it("still uses the generic path/language/symbol-name head-slice renderer for non-markdown files", async () => {
    const node: CodeNode = {
      id: "F1",
      kind: "file",
      name: "a.ts",
      path: "a.ts",
      range: { start: 0, end: 0 },
      language: "typescript",
    };
    const client = fakeClient();

    await ensureFileEmbeddings({
      graph: makeGraph([node]),
      root: "/repo",
      client,
      store: null,
      readFileText: async () => "export const x = 1;",
    });

    expect(client.calls[0]).toContain("a.ts");
    expect(client.calls[0]).toContain("typescript");
  });

  it("reuses a cached vector for a markdown node instead of re-embedding (incremental/cached)", async () => {
    const node: CodeNode = {
      id: "F1",
      kind: "file",
      name: "guide.md",
      path: "guide.md",
      range: { start: 0, end: 0 },
      language: "markdown",
      embedding: [0.5, 0.5],
      embeddingProvider: "fake-v1",
    };
    const client = fakeClient();

    const result = await ensureFileEmbeddings({
      graph: makeGraph([node]),
      root: "/repo",
      client,
      store: null,
      readFileText: async () => {
        throw new Error("should not read — vector is cached");
      },
    });

    expect(result.reused).toBe(1);
    expect(result.embedded).toBe(0);
    expect(client.calls).toHaveLength(0);
  });
});
