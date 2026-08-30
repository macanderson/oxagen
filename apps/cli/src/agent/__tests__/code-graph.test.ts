/**
 * Code-graph retrieval — proves the agent can answer structural questions about
 * a real on-disk project: symbol search, file-symbol listing, and (the part
 * that was previously broken) import/dependent resolution for impact analysis.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryCodeGraph,
  codeGraphStats,
  clearCodeGraphCache,
  warmCodeGraph,
} from "../code-graph.js";
import type { EmbeddingClient } from "../context/embedding.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "oxagen-cg-"));
  await fs.writeFile(
    join(root, "alpha.ts"),
    [
      "export function computeAlpha() {",
      "  return 1;",
      "}",
      "export interface AlphaShape {",
      "  x: number;",
      "}",
    ].join("\n"),
  );
  await fs.writeFile(
    join(root, "beta.ts"),
    [
      'import { computeAlpha } from "./alpha.js";',
      "export class BetaEngine {}",
      "export function runBeta() {",
      "  return computeAlpha();",
      "}",
    ].join("\n"),
  );
  await fs.mkdir(join(root, "sub"), { recursive: true });
  await fs.writeFile(
    join(root, "sub", "gamma.ts"),
    [
      'import { BetaEngine } from "../beta.js";',
      'export type GammaKind = "a" | "b";',
    ].join("\n"),
  );
});

afterAll(async () => {
  clearCodeGraphCache();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("code-graph retrieval", () => {
  it("search finds where a symbol is defined", async () => {
    const out = await queryCodeGraph(root, "search", "computeAlpha");
    expect(out).toContain("computeAlpha");
    expect(out).toContain("alpha.ts");
    expect(out).toContain("function");
  });

  it("search matches classes and is case-insensitive", async () => {
    const out = await queryCodeGraph(root, "search", "betaengine");
    expect(out).toContain("BetaEngine");
    expect(out).toContain("class");
  });

  it("file_symbols lists the symbols a file defines", async () => {
    const out = await queryCodeGraph(root, "file_symbols", "beta.ts");
    expect(out).toContain("BetaEngine");
    expect(out).toContain("runBeta");
  });

  it("dependents resolves who imports a file (impact analysis)", async () => {
    // beta.ts imports alpha.ts → alpha's dependents include beta.ts
    const alphaDeps = await queryCodeGraph(root, "dependents", "alpha.ts");
    expect(alphaDeps).toContain("beta.ts");

    // sub/gamma.ts imports ../beta.js → beta's dependents include sub/gamma.ts
    const betaDeps = await queryCodeGraph(root, "dependents", "beta.ts");
    expect(betaDeps).toContain("sub/gamma.ts");
  });

  it("imports resolves a file's local imports", async () => {
    const betaImports = await queryCodeGraph(root, "imports", "beta.ts");
    expect(betaImports).toContain("alpha.ts");

    const gammaImports = await queryCodeGraph(root, "imports", "sub/gamma.ts");
    expect(gammaImports).toContain("beta.ts");
  });

  it("reports a clear miss for unknown symbols and files", async () => {
    expect(await queryCodeGraph(root, "search", "doesNotExist")).toContain(
      "No symbols matching",
    );
    expect(await queryCodeGraph(root, "dependents", "nope.ts")).toContain(
      "No file matching",
    );
  });

  it("stats reflect the indexed fixture", async () => {
    const stats = await codeGraphStats(root);
    expect(stats.files).toBe(3);
    // computeAlpha, AlphaShape, BetaEngine, runBeta, GammaKind
    expect(stats.symbols).toBeGreaterThanOrEqual(5);
    expect(stats.edges).toBeGreaterThan(0);
  });

  it("warmCodeGraph primes the cache so the first query hits a built graph", async () => {
    clearCodeGraphCache();
    // Fire-and-forget warm-up returns synchronously (void) — it must not throw.
    expect(() => warmCodeGraph(root)).not.toThrow();
    // The subsequent real query resolves against the warmed graph.
    const out = await queryCodeGraph(root, "search", "computeAlpha", 5);
    expect(out).toContain("computeAlpha");
  });

  it("warmCodeGraph swallows errors for an unbuildable path (fire-and-forget)", () => {
    // A path that cannot be indexed must not surface an unhandled rejection.
    expect(() =>
      warmCodeGraph("/nonexistent/oxagen-warm-test-path"),
    ).not.toThrow();
  });
});

describe("code-graph semantic_search", () => {
  it("degrades gracefully (never throws) when no embedding client is available", async () => {
    // `client: null` simulates the offline / no-gateway-key case directly,
    // without needing to fake out AI_GATEWAY_API_KEY resolution.
    const out = await queryCodeGraph(
      root,
      "semantic_search",
      "project level configuration",
      5,
      {
        client: null,
      },
    );
    expect(out).toContain("No file matching semantic query");
  });

  it("ranks files by cosine similarity to a conceptual query with zero literal tokens", async () => {
    // A deterministic 2-axis fake client: alpha.ts's rendered text starts with
    // its own path ("alpha.ts"), so only its embedding lands on the [1, 0] axis;
    // everything else (including beta.ts, whose content merely imports
    // "./alpha.js") lands on [0, 1]. `store: null` skips DuckDB I/O — the ranked
    // result should still come back, just unpersisted.
    const fakeClient: EmbeddingClient = {
      providerId: "fake-test-v1",
      dimensions: 2,
      async embed(text) {
        return text.toLowerCase().includes("alpha") ? [1, 0] : [0, 1];
      },
      async embedBatch(texts) {
        return texts.map((t) =>
          t.toLowerCase().includes("alpha.ts") ? [1, 0] : [0, 1],
        );
      },
    };

    const out = await queryCodeGraph(
      root,
      "semantic_search",
      "tell me everything about alpha",
      5,
      { client: fakeClient, store: null },
    );

    expect(out).not.toContain("No file matching");
    expect(out).toContain("alpha.ts");
  });
});
