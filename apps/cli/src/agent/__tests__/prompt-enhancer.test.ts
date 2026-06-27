/**
 * Prompt enhancement — proves a raw prompt is enriched with real code-graph
 * context (symbol definitions, file symbols, dependents) and recalled lessons,
 * and that it degrades to a no-op when there is nothing to add.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidates, enhancePrompt } from "../prompt-enhancer.js";
import { clearCodeGraphCache } from "../code-graph.js";
import type { FleetMemory } from "../fleet/memory.js";
import type { MemoryRecord } from "../fleet/types.js";

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
    ['import { BetaEngine } from "../beta.js";', "export const g = new BetaEngine();"].join("\n"),
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
      kind: "gotcha",
      weight: "critical",
      lesson: "beta.ts must keep its default export",
      files: ["beta.ts"],
      outcome: "success",
    };
    const memory: FleetMemory = { record: () => undefined, recall: () => [lesson], all: () => [] };
    const res = await enhancePrompt({ prompt: "touch beta.ts", cwd: root, memory });
    expect(res.lessons).toHaveLength(1);
    expect(res.context).toContain("Lessons from past work");
    expect(res.context).toContain("must keep its default export");
  });

  it("is a no-op when nothing is found", async () => {
    const res = await enhancePrompt({ prompt: "hello there friend", cwd: root, memory: noMemory });
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
});
