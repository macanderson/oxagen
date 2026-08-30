/**
 * Prompt enhancement — proves a raw prompt is enriched with real code-graph
 * context (symbol definitions, file symbols, dependents) and recalled lessons,
 * and that it degrades to a no-op when there is nothing to add.
 *
 * Three modules are mocked at module scope so `resolveEmbeddingClient()`
 * (reached by the semantic fallback whenever a test exercises the real,
 * non-injected `queryCodeGraph`) resolves to "no backend available" through
 * EVERY tier, regardless of this machine's actual environment:
 *   - `../env.js` — the gateway tier sees no key, regardless of a real
 *     `AI_GATEWAY_API_KEY` / `~/.config/oxagen/config.json`.
 *   - `../context/embedding-ollama.js` — the Ollama tier never makes a real
 *     HTTP call, regardless of whether Ollama actually happens to be running
 *     on this machine's localhost:11434.
 *   - `../context/embedding-onnx.js` — the ONNX tier never attempts a real
 *     dynamic import / model load, regardless of whether the optional
 *     `fastembed` dependency happens to be installed.
 * A real backend answering here must never turn a unit test into a live
 * network call or a multi-second model load.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidates, enhancePrompt } from "../prompt-enhancer.js";
import { clearCodeGraphCache } from "../code-graph.js";
import type { FleetMemory } from "../fleet/memory.js";
import type { MemoryRecord } from "../fleet/memory.js";

vi.mock("../env.js", () => ({
  ensureGatewayKey: () => null,
  resolveAiCredential: () => null,
  MissingAiKeyError: class MissingAiKeyError extends Error {},
}));

vi.mock("../context/embedding-ollama.js", () => ({
  createOllamaEmbeddingClient: async () => null,
  probeOllama: async () => null,
}));

vi.mock("../context/embedding-onnx.js", () => ({
  createOnnxEmbeddingClient: async () => null,
  isOnnxAvailable: async () => false,
}));

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "oxagen-pe-"));
  await fs.writeFile(
    join(root, "alpha.ts"),
    ["export function computeAlpha() {", "  return 1;", "}"].join("\n"),
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
      "export const g = new BetaEngine();",
    ].join("\n"),
  );
});

afterAll(async () => {
  clearCodeGraphCache();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("extractCandidates", () => {
  it("pulls backticked symbols and paths, CamelCase and snake_case", () => {
    const { symbols, paths } = extractCandidates(
      "where is `computeAlpha` defined? look at `src/agent/loop.ts` and the GraphNode type and build_tools fn and edit alpha.ts",
    );
    expect(symbols).toContain("computeAlpha");
    expect(symbols).toContain("GraphNode");
    expect(symbols).toContain("build_tools");
    expect(paths).toContain("src/agent/loop.ts");
    expect(paths).toContain("alpha.ts");
  });
});

const noMemory: FleetMemory = {
  record: () => undefined,
  recall: () => [],
  all: () => [],
};

describe("enhancePrompt", () => {
  it("retrieves symbol definitions, file symbols and dependents", async () => {
    const res = await enhancePrompt({
      prompt: "where is `computeAlpha` defined and what imports `beta.ts`?",
      cwd: root,
      memory: noMemory,
    });
    expect(res.resolved).toContain("computeAlpha");
    expect(res.resolved).toContain("beta.ts");
    expect(res.context).toContain("alpha.ts"); // computeAlpha's definition site
    expect(res.context).toContain("Symbols in beta.ts");
    expect(res.context).toContain("sub/gamma.ts"); // dependent of beta.ts
    // The enhanced prompt keeps the original text and appends the context block.
    expect(res.prompt.startsWith("where is")).toBe(true);
    expect(res.prompt).toContain("Relevant code context");
  });

  it("injects recalled lessons as a context section", async () => {
    const lesson: MemoryRecord = {
      id: "m1",
      createdAt: 1,
      memoryKind: "gotcha",
      memoryClass: "RULE",
      enforcementScore: 95,
      lesson: "beta.ts must keep its default export",
      files: ["beta.ts"],
      outcome: "success",
    };
    const memory: FleetMemory = {
      record: () => undefined,
      recall: () => [lesson],
      all: () => [],
    };
    const res = await enhancePrompt({
      prompt: "touch beta.ts",
      cwd: root,
      memory,
    });
    expect(res.lessons).toHaveLength(1);
    // Header text comes from the shared @oxagen/agent-engine enhancePrompt this
    // adapter now delegates to, not a CLI-local "Lessons from past work" string.
    expect(res.context).toContain("Recalled context");
    expect(res.context).toContain("must keep its default export");
  });

  it("resolves context from extraQueries even when the prompt names nothing", async () => {
    const res = await enhancePrompt({
      prompt: "do the thing",
      cwd: root,
      memory: noMemory,
      extraQueries: ["computeAlpha", "beta.ts"],
    });
    expect(res.resolved).toContain("computeAlpha");
    expect(res.resolved).toContain("beta.ts");
    expect(res.context).toContain("Relevant code context");
    // extraQueries sharpen retrieval but never pollute the visible prompt text.
    expect(res.prompt.startsWith("do the thing")).toBe(true);
    expect(res.prompt).not.toContain("computeAlpha\n");
  });

  it("is a no-op when nothing is found", async () => {
    const res = await enhancePrompt({
      prompt: "hello there friend",
      cwd: root,
      memory: noMemory,
    });
    expect(res.context).toBe("");
    expect(res.prompt).toBe("hello there friend");
    expect(res.resolved).toHaveLength(0);
  });

  it("never throws and degrades when the cwd is unreadable", async () => {
    const res = await enhancePrompt({
      prompt: "look at `Thing`",
      cwd: join(root, "does-not-exist"),
      memory: noMemory,
    });
    expect(res.prompt).toContain("look at");
  });

  it("falls back to semantic search for a conceptual prompt with zero literal tokens", async () => {
    // "project level configurations for the cli app" names no symbol or path —
    // extractCandidates yields nothing, so without the semantic fallback this
    // would inject no context at all (the exact gap this feature closes).
    const queryFn = vi.fn(async (_cwd: string, operation: string) => {
      if (operation === "semantic_search") {
        return "apps/cli/oxagen.config.ts (0.81)\napps/cli/src/lib/config.ts (0.63)";
      }
      return operation === "search"
        ? "No symbols matching."
        : "No file matching.";
    });

    const res = await enhancePrompt({
      prompt: "project level configurations for the cli app",
      cwd: root,
      memory: noMemory,
      queryCodeGraph: queryFn,
    });

    expect(queryFn).toHaveBeenCalledWith(
      root,
      "semantic_search",
      "project level configurations for the cli app",
      expect.any(Number),
    );
    expect(res.usedSemanticFallback).toBe(true);
    expect(res.context).toContain("Semantically relevant files");
    expect(res.context).toContain("oxagen.config.ts");
    expect(res.prompt).toContain("Semantically relevant files");
  });

  it("skips the semantic fallback once literal candidates already resolved enough", async () => {
    const queryFn = vi.fn(
      async (_cwd: string, operation: string, q: string) => {
        if (operation === "search" && q === "computeAlpha") {
          return "function computeAlpha — alpha.ts:1";
        }
        if (operation === "file_symbols" && q === "beta.ts") {
          return "beta.ts:\nclass BetaEngine — beta.ts:2";
        }
        if (operation === "semantic_search")
          return "should-not-be-used.ts (0.99)";
        return "No file matching.";
      },
    );

    const res = await enhancePrompt({
      prompt: "where is `computeAlpha` defined and what is in `beta.ts`?",
      cwd: root,
      memory: noMemory,
      queryCodeGraph: queryFn,
    });

    expect(res.usedSemanticFallback).toBe(false);
    expect(res.context).not.toContain("should-not-be-used.ts");
    expect(
      queryFn.mock.calls.some((call) => call[1] === "semantic_search"),
    ).toBe(false);
  });
});
