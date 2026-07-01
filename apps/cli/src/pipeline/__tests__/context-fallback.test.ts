import { describe, expect, it, vi } from "vitest";
import { GrepFallbackResolver } from "../context-fallback.js";
import { formatPipelineLine, type PipelineLogEntry } from "../pipeline-logging.js";
import type { GraphResult } from "../context-fallback.js";

function capture() {
  const lines: string[] = [];
  const log = (e: PipelineLogEntry) => lines.push(formatPipelineLine(e));
  return { log, lines };
}

const rich: GraphResult = {
  impactedFiles: [{ path: "src/a.ts", reason: "r" }],
  symbols: [],
  edges: [],
  coverage: 0.9,
};

describe("GrepFallbackResolver", () => {
  it("uses the graph when it answers above the coverage threshold and logs source=graphrag", async () => {
    const { log, lines } = capture();
    const graph = vi.fn(async () => rich);
    const resolver = new GrepFallbackResolver({ graph, log });
    const r = await resolver.query({ query: "widgets route" });
    expect(r.coverage).toBe(0.9);
    expect(resolver.usedGraph()).toBe(true);
    expect(lines.some((l) => l.startsWith("[graph]") && l.includes("source=graphrag"))).toBe(true);
  });

  it("falls back to grep and logs source=grep-fallback when there is no graph client", async () => {
    const { log, lines } = capture();
    const search = vi.fn(async () => [{ path: "src/found.ts", reason: 'matches "widgets"' }]);
    const resolver = new GrepFallbackResolver({ search, log });
    const r = await resolver.query({ query: "widgets route" });
    expect(resolver.usedGraph()).toBe(false);
    expect(r.impactedFiles[0]!.path).toBe("src/found.ts");
    expect(r.coverage).toBeLessThanOrEqual(0.4);
    expect(lines.some((l) => l.startsWith("[graph]") && l.includes("source=grep-fallback"))).toBe(true);
  });

  it("falls back to grep when the graph is below the coverage threshold", async () => {
    const { log } = capture();
    const graph = vi.fn(async () => ({ ...rich, coverage: 0.2 }));
    const search = vi.fn(async () => []);
    const resolver = new GrepFallbackResolver({ graph, search, log, coverageThreshold: 0.5 });
    await resolver.query({ query: "something obscure" });
    expect(resolver.usedGraph()).toBe(false);
    expect(search).toHaveBeenCalledOnce();
  });

  it("falls back to grep when the graph client throws", async () => {
    const { log } = capture();
    const graph = vi.fn(async () => {
      throw new Error("graph down");
    });
    const search = vi.fn(async () => [{ path: "x.ts", reason: "m" }]);
    const resolver = new GrepFallbackResolver({ graph, search, log });
    const r = await resolver.query({ query: "widgets" });
    expect(resolver.usedGraph()).toBe(false);
    expect(r.impactedFiles).toHaveLength(1);
  });

  it("reports zero coverage when grep finds nothing", async () => {
    const { log } = capture();
    const resolver = new GrepFallbackResolver({ search: async () => [], log });
    const r = await resolver.query({ query: "nomatch" });
    expect(r.coverage).toBe(0);
    expect(r.impactedFiles).toEqual([]);
  });
});
