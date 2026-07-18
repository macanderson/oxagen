/**
 * Coverage for the speculation cache layer (ADR-030): prediction launch,
 * cache hits (resolved AND in-flight), whole-cache invalidation on mutation,
 * the mutation-in-flight speculation fence, concurrency/size caps, key
 * canonicalization, and stats. House style: dependency injection — handcrafted
 * fake ToolSets with counting executes; no vi.mock.
 */
import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import {
  wrapToolsWithSpeculation,
  speculationKey,
  type SpeculationStats,
} from "./layer";
import type { SpeculationPredictor } from "./predictor";

type Exec = (input: unknown, options: unknown) => Promise<unknown>;

/** Await pending microtasks so fire-and-forget speculations settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeTools(overrides: Partial<Record<string, Exec>> = {}): {
  tools: ToolSet;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    read_file: [],
    grep: [],
    glob: [],
    bash: [],
    ask_user: [],
  };
  const make = (name: string, fallback: Exec): { execute: Exec } => ({
    execute: async (input: unknown, options: unknown) => {
      calls[name]!.push(input);
      return (overrides[name] ?? fallback)(input, options);
    },
  });
  const tools = {
    read_file: make(
      "read_file",
      async (i) => `content of ${(i as { path: string }).path}`,
    ),
    grep: make("grep", async () => "src/a.ts:1:hit\nsrc/b.ts:2:hit"),
    glob: make("glob", async () => "src/a.ts\nsrc/b.ts"),
    bash: make("bash", async () => "ok"),
    ask_user: make("ask_user", async () => "answer"),
    no_execute: { description: "schema-only tool" },
  } as unknown as ToolSet;
  return { tools, calls };
}

function run(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  return (tools[name] as { execute: Exec }).execute(input, {});
}

describe("wrapToolsWithSpeculation — prediction and cache hits", () => {
  it("speculates grep hit files and serves the real follow-up from cache", async () => {
    const { tools, calls } = makeTools();
    let last: SpeculationStats | undefined;
    const wrapped = wrapToolsWithSpeculation(tools, {
      onStats: (s) => (last = s),
    });

    await run(wrapped, "grep", { pattern: "hit" });
    await settle();
    // Both hit files were prefetched against the raw executes.
    expect(calls["read_file"]).toEqual([
      { path: "src/a.ts" },
      { path: "src/b.ts" },
    ]);

    const result = await run(wrapped, "read_file", { path: "src/a.ts" });
    expect(result).toBe("content of src/a.ts");
    // Served from cache: no third underlying read.
    expect(calls["read_file"]).toHaveLength(2);
    expect(last).toMatchObject({ predicted: 2, hits: 1, misses: 1 });
  });

  it("consumes a cache entry on hit — the next identical call re-reads", async () => {
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools);
    await run(wrapped, "grep", { pattern: "hit" });
    await settle();
    await run(wrapped, "read_file", { path: "src/a.ts" }); // hit, consumes
    await run(wrapped, "read_file", { path: "src/a.ts" }); // miss, fresh read
    expect(calls["read_file"]).toHaveLength(3);
  });

  it("awaits an in-flight speculation instead of re-executing", async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const { tools, calls } = makeTools({ read_file: () => gate });
    const wrapped = wrapToolsWithSpeculation(tools, {
      // Predict only from grep: an unconditional predictor would re-speculate
      // the same path AFTER the hit consumes its entry, double-counting reads.
      predictor: (obs) =>
        obs.tool === "grep"
          ? [{ tool: "read_file", input: { path: "slow.ts" } }]
          : [],
    });

    await run(wrapped, "grep", { pattern: "hit" }); // launches the speculation
    const pending = run(wrapped, "read_file", { path: "slow.ts" }); // hits in-flight
    release("slow content");
    expect(await pending).toBe("slow content");
    expect(calls["read_file"]).toHaveLength(1); // executed exactly once
  });

  it("serves a speculated FAILURE exactly as a live call would return it", async () => {
    const { tools, calls } = makeTools({
      read_file: async () => {
        throw new Error("boom");
      },
    });
    const wrapped = wrapToolsWithSpeculation(tools, {
      predictor: (obs) =>
        obs.tool === "grep"
          ? [{ tool: "read_file", input: { path: "x.ts" } }]
          : [],
    });
    await run(wrapped, "grep", { pattern: "hit" });
    await settle();
    const result = await run(wrapped, "read_file", { path: "x.ts" });
    expect(result).toBe("Error: boom");
    expect(calls["read_file"]).toHaveLength(1);
  });

  it("honors an injected predictor", async () => {
    const predictor: SpeculationPredictor = () => [
      { tool: "read_file", input: { path: "predicted.ts" } },
    ];
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools, { predictor });
    await run(wrapped, "read_file", { path: "seed.ts" });
    await settle();
    expect(calls["read_file"]).toEqual([
      { path: "seed.ts" },
      { path: "predicted.ts" },
    ]);
  });

  it("never speculates tools off the read-only allowlist", async () => {
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools, {
      predictor: () => [
        { tool: "bash", input: { command: "rm -rf /" } },
        { tool: "ask_user", input: {} },
        { tool: "missing_tool", input: {} },
      ],
    });
    await run(wrapped, "read_file", { path: "seed.ts" });
    await settle();
    expect(calls["bash"]).toHaveLength(0);
    expect(calls["ask_user"]).toHaveLength(0);
  });
});

describe("wrapToolsWithSpeculation — invalidation", () => {
  it("drops the whole cache when a mutating tool runs", async () => {
    const { tools, calls } = makeTools();
    let last: SpeculationStats | undefined;
    const wrapped = wrapToolsWithSpeculation(tools, {
      onStats: (s) => (last = s),
    });

    await run(wrapped, "grep", { pattern: "hit" });
    await settle(); // two entries cached
    await run(wrapped, "bash", { command: "sed -i s/a/b/ src/a.ts" });

    await run(wrapped, "read_file", { path: "src/a.ts" });
    expect(calls["read_file"]).toHaveLength(3); // 2 speculative + 1 fresh (no stale serve)
    expect(last!.wasted).toBe(2);
    expect(last!.invalidations).toBeGreaterThanOrEqual(2); // both edges of the mutation
  });

  it("suspends speculation while a mutation is in flight", async () => {
    let releaseBash!: (v: string) => void;
    const bashGate = new Promise<string>((r) => (releaseBash = r));
    const { tools, calls } = makeTools({ bash: () => bashGate });
    let last: SpeculationStats | undefined;
    const wrapped = wrapToolsWithSpeculation(tools, {
      onStats: (s) => (last = s),
    });

    const bashPending = run(wrapped, "bash", { command: "slow-mutation" });
    await run(wrapped, "grep", { pattern: "hit" }); // completes mid-mutation
    await settle();
    expect(calls["read_file"]).toHaveLength(0); // fence held — nothing speculated
    expect(last!.predicted).toBe(0);

    releaseBash("done");
    await bashPending;
  });

  it("does NOT invalidate on known-pure tools", async () => {
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools);
    await run(wrapped, "grep", { pattern: "hit" });
    await settle();
    await run(wrapped, "ask_user", { question: "which?" });
    await run(wrapped, "read_file", { path: "src/a.ts" });
    expect(calls["read_file"]).toHaveLength(2); // cache survived, hit served
  });

  it("passes through tools with no execute untouched", () => {
    const { tools } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools);
    expect(wrapped["no_execute"]).toBe(tools["no_execute"]);
  });
});

describe("wrapToolsWithSpeculation — caps", () => {
  it("caps concurrent speculative executions", async () => {
    const { tools, calls } = makeTools({
      grep: async () => "src/a.ts:1:x\nsrc/b.ts:1:x\nsrc/c.ts:1:x",
      read_file: () => new Promise(() => undefined), // never resolves
    });
    let last: SpeculationStats | undefined;
    const wrapped = wrapToolsWithSpeculation(tools, {
      maxConcurrent: 2,
      onStats: (s) => (last = s),
    });
    await run(wrapped, "grep", { pattern: "x" }); // predicts 3 files
    await settle();
    expect(calls["read_file"]).toHaveLength(2);
    expect(last!.predicted).toBe(2);
  });

  it("caps total cached entries", async () => {
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools, {
      maxCacheEntries: 1,
      maxConcurrent: 10,
      predictor: () => [
        { tool: "read_file", input: { path: "p1.ts" } },
        { tool: "read_file", input: { path: "p2.ts" } },
      ],
    });
    await run(wrapped, "read_file", { path: "seed.ts" });
    await settle();
    // seed + exactly one cached speculation
    expect(calls["read_file"]).toHaveLength(2);
  });

  it("never launches a duplicate speculation for the same key", async () => {
    const { tools, calls } = makeTools();
    const wrapped = wrapToolsWithSpeculation(tools, {
      predictor: () => [
        { tool: "read_file", input: { path: "same.ts" } },
        { tool: "read_file", input: { path: "same.ts" } },
      ],
    });
    await run(wrapped, "read_file", { path: "seed.ts" });
    await settle();
    expect(calls["read_file"]).toEqual([
      { path: "seed.ts" },
      { path: "same.ts" },
    ]);
  });
});

describe("wrapToolsWithSpeculation — code_graph (agent-engine v2 Phase 0)", () => {
  // Self-contained ToolSet: code_graph answers in the platform row format so
  // the default predictor can mine follow-up reads from it.
  function makeGraphTools(): {
    tools: ToolSet;
    calls: Record<string, unknown[]>;
  } {
    const calls: Record<string, unknown[]> = { read_file: [], code_graph: [] };
    const make = (name: string, fallback: Exec): { execute: Exec } => ({
      execute: async (input: unknown, options: unknown) => {
        calls[name]!.push(input);
        return fallback(input, options);
      },
    });
    const tools = {
      read_file: make(
        "read_file",
        async (i) => `content of ${(i as { path: string }).path}`,
      ),
      code_graph: make(
        "code_graph",
        async () =>
          "src/dep1.ts:5: function useA\nsrc/dep2.ts:9: function useB",
      ),
    } as unknown as ToolSet;
    return { tools, calls };
  }

  it("prefetches the dependents query after a read and serves the model's follow-up from cache", async () => {
    const { tools, calls } = makeGraphTools();
    const wrapped = wrapToolsWithSpeculation(tools);

    await run(wrapped, "read_file", { path: "src/a.ts" });
    await settle();
    // Deterministic impact prefetch — and ONLY that; semantic_search is never
    // speculated (predictor-level exclusion, see predictor.test.ts).
    expect(calls["code_graph"]).toEqual([
      { operation: "dependents", query: "src/a.ts" },
    ]);

    const result = await run(wrapped, "code_graph", {
      operation: "dependents",
      query: "src/a.ts",
    });
    expect(result).toContain("src/dep1.ts");
    expect(calls["code_graph"]).toHaveLength(1); // served from cache

    // The served graph answer feeds the predictor in turn: the listed
    // dependents get prefetched as reads (read → graph → read chaining).
    await settle();
    expect(calls["read_file"]).toEqual([
      { path: "src/a.ts" },
      { path: "src/dep1.ts" },
      { path: "src/dep2.ts" },
    ]);
  });

  it("does not invalidate the cache on a code_graph call (no longer treated as a mutation)", async () => {
    const { tools, calls } = makeGraphTools();
    const wrapped = wrapToolsWithSpeculation(tools);
    await run(wrapped, "read_file", { path: "src/a.ts" }); // caches the dependents prefetch
    await settle();
    await run(wrapped, "code_graph", { operation: "search", query: "useA" }); // miss — executes
    const before = calls["code_graph"]!.length;
    await run(wrapped, "code_graph", {
      operation: "dependents",
      query: "src/a.ts",
    });
    expect(calls["code_graph"]).toHaveLength(before); // still a cache hit — nothing was dropped
  });
});

describe("speculationKey", () => {
  it("canonicalizes key order and drops undefined values", () => {
    expect(
      speculationKey("read_file", { path: "a.ts", offset: undefined }),
    ).toBe(speculationKey("read_file", { path: "a.ts" }));
    expect(speculationKey("grep", { pattern: "x", path: "src" })).toBe(
      speculationKey("grep", { path: "src", pattern: "x" }),
    );
    expect(speculationKey("read_file", { path: "a.ts" })).not.toBe(
      speculationKey("read_file", { path: "b.ts" }),
    );
    expect(speculationKey("glob", { list: [1, "two", null] })).toBe(
      'glob {"list":[1,"two",null]}',
    );
  });
});
