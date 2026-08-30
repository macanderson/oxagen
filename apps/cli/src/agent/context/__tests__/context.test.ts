import { describe, it, expect, vi, afterEach } from "vitest";
import {
  makeGraph,
  FakeEmbeddingClient,
  embedFixtureFiles,
} from "./fixtures.js";
import {
  mergeGraphConfig,
  DEFAULT_GRAPH_CONFIG,
  MIN_COVERAGE,
} from "../config.js";
import {
  tokenize,
  resolveSeeds,
  expandNeighbourhood,
  callFlow,
} from "../traversal.js";
import {
  ensureFileEmbeddings,
  rankFilesBySimilarity,
} from "../semantic-index.js";
import { runGraphQuery } from "../graph-query.js";
import {
  GraphContextResolver,
  type GraphLogEvent,
  type GraphResult,
} from "../context-resolver.js";
import {
  formatGraphResultJson,
  formatGraphContextForPrompt,
} from "../format.js";
import { resolveEmbeddingClient } from "../embedding.js";
import type { CodeGraphStore } from "../../../daemon/code-graph/store.js";

afterEach(() => {
  delete process.env["OXAGEN_GRAPH_DISABLED"];
  delete process.env["OXAGEN_EMBED_PROVIDER"];
});

// ── config ────────────────────────────────────────────────────────────────
describe("graph config", () => {
  it("defaults match DEFAULT_GRAPH_CONFIG", () => {
    const c = mergeGraphConfig();
    expect(c).toEqual({
      enabled: true,
      endpoint: "http://localhost:0/graphrag",
      maxNodes: 200,
      fallbackToGrep: true,
      embedProvider: "auto",
    });
  });

  it("layers a partial patch over defaults", () => {
    expect(
      mergeGraphConfig({ maxNodes: 50, fallbackToGrep: false }),
    ).toMatchObject({
      maxNodes: 50,
      fallbackToGrep: false,
      enabled: true,
    });
  });

  it("OXAGEN_GRAPH_DISABLED forces enabled=false", () => {
    process.env["OXAGEN_GRAPH_DISABLED"] = "1";
    expect(mergeGraphConfig({ enabled: true }).enabled).toBe(false);
  });

  it("embedProvider defaults to auto and honours a patch", () => {
    expect(mergeGraphConfig().embedProvider).toBe("auto");
    expect(mergeGraphConfig({ embedProvider: "ollama" }).embedProvider).toBe(
      "ollama",
    );
  });

  it("OXAGEN_EMBED_PROVIDER overrides both the default and a patch", () => {
    process.env["OXAGEN_EMBED_PROVIDER"] = "off";
    expect(mergeGraphConfig({ embedProvider: "ollama" }).embedProvider).toBe(
      "off",
    );
  });

  it("OXAGEN_EMBED_PROVIDER accepts 'local' as an alias for 'onnx'", () => {
    process.env["OXAGEN_EMBED_PROVIDER"] = "local";
    expect(mergeGraphConfig().embedProvider).toBe("onnx");
  });

  it("an invalid OXAGEN_EMBED_PROVIDER value falls back to the patch/default instead of throwing", () => {
    process.env["OXAGEN_EMBED_PROVIDER"] = "not-a-real-provider";
    expect(mergeGraphConfig().embedProvider).toBe("auto");
  });
});

// ── traversal ───────────────────────────────────────────────────────────────
describe("traversal", () => {
  it("tokenize splits camelCase and drops short/noise tokens", () => {
    expect(tokenize("processPayment based on cardType")).toEqual([
      "process",
      "payment",
      "based",
      "card",
      "type",
    ]);
  });

  it("resolveSeeds anchors on focus symbols", () => {
    const g = makeGraph();
    const seeds = resolveSeeds(g, { focusSymbols: ["processPayment"] });
    expect(seeds.map((s) => s.name)).toContain("processPayment");
  });

  it("resolveSeeds anchors on query tokens", () => {
    const g = makeGraph();
    const seeds = resolveSeeds(g, { query: "route the payment by card" });
    expect(seeds.map((s) => s.name)).toEqual(
      expect.arrayContaining(["processPayment", "routeByCardType"]),
    );
  });

  it("expandNeighbourhood pulls the containing file and n-hop neighbours", () => {
    const g = makeGraph();
    const sub = expandNeighbourhood(g, ["S1"], { hops: 2, maxNodes: 200 });
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids).toContain("S1"); // seed
    expect(ids).toContain("F1"); // containing file
    expect(ids).toContain("S2"); // processPayment → routeByCardType
    expect(ids).toContain("S3"); // handleCheckout → processPayment
    expect(ids).not.toContain("S4"); // unrelated telemetry symbol
  });

  it("expandNeighbourhood respects maxNodes", () => {
    const g = makeGraph();
    const sub = expandNeighbourhood(g, ["S1"], { hops: 3, maxNodes: 2 });
    expect(sub.nodes.length).toBeLessThanOrEqual(2);
  });

  it("callFlow(callers) finds who invokes a function", () => {
    const g = makeGraph();
    const sub = callFlow(g, "S1", {
      direction: "callers",
      depth: 2,
      maxNodes: 200,
    });
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("handleCheckout"); // caller of processPayment
    expect(names).not.toContain("routeByCardType"); // that's a callee, not a caller
  });

  it("callFlow(callees) finds what a function invokes", () => {
    const g = makeGraph();
    const sub = callFlow(g, "S1", {
      direction: "callees",
      depth: 2,
      maxNodes: 200,
    });
    expect(sub.nodes.map((n) => n.name)).toContain("routeByCardType");
  });
});

// ── semantic index ────────────────────────────────────────────────────────
describe("semantic index", () => {
  it("embeds file nodes once, then reuses persisted vectors", async () => {
    const g = makeGraph();
    const client = new FakeEmbeddingClient();
    const readFileText = async (abs: string): Promise<string> =>
      `telemetry drain ${abs}`;

    const first = await ensureFileEmbeddings({
      graph: g,
      root: "/repo",
      client,
      readFileText,
    });
    expect(first.embedded).toBe(4); // 4 file nodes
    expect(first.vectors.size).toBe(4);

    const second = await ensureFileEmbeddings({
      graph: g,
      root: "/repo",
      client,
      readFileText,
    });
    expect(second.embedded).toBe(0);
    expect(second.reused).toBe(4);
  });

  it("persists vectors through the store when supplied", async () => {
    const g = makeGraph();
    const client = new FakeEmbeddingClient();
    const updateNodeEmbeddings = vi.fn(async () => {});
    const store = { updateNodeEmbeddings } as unknown as CodeGraphStore;
    await ensureFileEmbeddings({
      graph: g,
      root: "/repo",
      client,
      store,
      readFileText: async () => "payment card",
    });
    expect(updateNodeEmbeddings).toHaveBeenCalledOnce();
  });

  it("rankFilesBySimilarity orders by cosine and drops zero-similarity files", () => {
    const g = makeGraph();
    const client = new FakeEmbeddingClient();
    embedFixtureFiles(g, client);
    const vectors = new Map(
      [...g.nodes.values()]
        .filter((n) => n.kind === "file")
        .map((n) => [n.id, n.embedding!]),
    );
    // "telemetry drain" query vector.
    const q = [0, 0, 0, 1, 1, 0];
    const ranked = rankFilesBySimilarity(g, q, vectors, 10);
    expect(ranked[0]?.path).toBe("src/telemetry/drain.ts");
  });
});

// ── graph_query core ─────────────────────────────────────────────────────
describe("runGraphQuery", () => {
  it("returns structural context with no embedding client (offline)", async () => {
    const g = makeGraph();
    const res = await runGraphQuery({
      input: { query: "processPayment" },
      graph: g,
      root: "/repo",
      client: null,
      config: DEFAULT_GRAPH_CONFIG,
    });
    expect(res.impactedFiles.some((f) => f.path.endsWith("processor.ts"))).toBe(
      true,
    );
    expect(res.symbols.some((s) => s.name === "processPayment")).toBe(true);
    expect(res.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
  });

  it("ranks the semantically-closest file first", async () => {
    const g = makeGraph();
    const client = new FakeEmbeddingClient();
    embedFixtureFiles(g, client);
    const res = await runGraphQuery({
      input: { query: "telemetry drain" },
      graph: g,
      root: "/repo",
      client,
      config: DEFAULT_GRAPH_CONFIG,
    });
    expect(res.impactedFiles[0]?.path).toBe("src/telemetry/drain.ts");
    expect(res.coverage).toBeGreaterThan(0);
  });

  it("flow=callers surfaces the invoker in the subgraph", async () => {
    const g = makeGraph();
    const res = await runGraphQuery({
      input: { query: "processPayment", flow: "callers" },
      graph: g,
      root: "/repo",
      client: null,
      config: DEFAULT_GRAPH_CONFIG,
    });
    expect(res.symbols.some((s) => s.name === "handleCheckout")).toBe(true);
    expect(
      res.edges.some((e) => e.to === "processPayment" && e.type === "calls"),
    ).toBe(true);
  });

  it("honours maxNodes", async () => {
    const g = makeGraph();
    const res = await runGraphQuery({
      input: { query: "payment", maxNodes: 1 },
      graph: g,
      root: "/repo",
      client: null,
      config: DEFAULT_GRAPH_CONFIG,
    });
    expect(res.impactedFiles.length).toBeLessThanOrEqual(1);
  });

  it("reports zero coverage when nothing matches", async () => {
    const g = makeGraph();
    const res = await runGraphQuery({
      input: { query: "quuux zzznope" },
      graph: g,
      root: "/repo",
      client: null,
      config: DEFAULT_GRAPH_CONFIG,
    });
    expect(res.coverage).toBe(0);
    expect(res.impactedFiles).toHaveLength(0);
  });
});

// ── resolver: graph-first with logged fallback ──────────────────────────────
describe("GraphContextResolver", () => {
  const build = (
    over: Partial<ConstructorParameters<typeof GraphContextResolver>[0]> = {},
  ) => {
    const logs: GraphLogEvent[] = [];
    const grep = vi.fn(
      async (): Promise<GraphResult["impactedFiles"]> => [
        { path: "grepped.ts", reason: "grep match (1 hit)" },
      ],
    );
    const resolver = new GraphContextResolver({
      cwd: "/repo",
      config: DEFAULT_GRAPH_CONFIG,
      loadGraph: async () => makeGraph(),
      resolveClient: async () => null,
      grep,
      log: (e) => logs.push(e),
      ...over,
    });
    return { resolver, logs, grep };
  };

  it("answers from the graph and NEVER calls grep on a hit", async () => {
    const { resolver, logs, grep } = build();
    const res = await resolver.query({ query: "processPayment" });
    expect(grep).not.toHaveBeenCalled();
    expect(resolver.usedGraph()).toBe(true);
    expect(res.impactedFiles.some((f) => f.path.endsWith("processor.ts"))).toBe(
      true,
    );
    expect(logs.find((l) => l.kind === "hit")).toBeTruthy();
  });

  it("logs a fallback reason and uses grep on a miss", async () => {
    const { resolver, logs, grep } = build();
    const res = await resolver.query({ query: "quuux zzznope" });
    expect(grep).toHaveBeenCalledOnce();
    expect(resolver.usedGraph()).toBe(false);
    const fb = logs.find((l) => l.kind === "fallback");
    expect(fb).toMatchObject({ kind: "fallback", to: "grep" });
    expect(res.impactedFiles[0]?.path).toBe("grepped.ts");
  });

  it("falls back (logged) when the graph is disabled", async () => {
    const { resolver, logs, grep } = build({
      config: { ...DEFAULT_GRAPH_CONFIG, enabled: false },
    });
    await resolver.query({ query: "processPayment" });
    expect(grep).toHaveBeenCalledOnce();
    expect(
      logs.find(
        (l) => l.kind === "fallback" && /enabled is false/.test(l.reason),
      ),
    ).toBeTruthy();
  });

  it("falls back (logged) on an empty graph", async () => {
    const { resolver, grep, logs } = build({
      loadGraph: async () => ({ nodes: new Map(), edges: [] }),
    });
    await resolver.query({ query: "processPayment" });
    expect(grep).toHaveBeenCalledOnce();
    expect(
      logs.find((l) => l.kind === "fallback" && /empty/.test(l.reason)),
    ).toBeTruthy();
  });

  it("does not grep when fallbackToGrep is off", async () => {
    const { resolver, grep } = build({
      config: { ...DEFAULT_GRAPH_CONFIG, fallbackToGrep: false },
    });
    const res = await resolver.query({ query: "quuux zzznope" });
    expect(grep).not.toHaveBeenCalled();
    expect(res.impactedFiles).toHaveLength(0);
  });
});

// ── formatters (worker prompt includes the graph context) ───────────────────
describe("formatters", () => {
  const result: GraphResult = {
    impactedFiles: [
      {
        path: "src/payment/processor.ts",
        reason: "defines processPayment",
        rank: 1,
      },
    ],
    symbols: [
      {
        name: "processPayment",
        kind: "function",
        file: "src/payment/processor.ts",
        line: 10,
      },
    ],
    edges: [{ from: "handleCheckout", to: "processPayment", type: "calls" }],
    coverage: 0.8,
  };

  it("formatGraphResultJson emits the contract shape", () => {
    const parsed = JSON.parse(formatGraphResultJson(result));
    expect(Object.keys(parsed)).toEqual([
      "impactedFiles",
      "symbols",
      "edges",
      "coverage",
    ]);
    expect(parsed.coverage).toBe(0.8);
  });

  it("formatGraphContextForPrompt folds files, symbols and edges into the prompt", () => {
    const block = formatGraphContextForPrompt(result);
    expect(block).toContain("Impacted files:");
    expect(block).toContain("src/payment/processor.ts");
    expect(block).toContain("processPayment");
    expect(block).toContain("handleCheckout —calls→ processPayment");
  });

  it("formatGraphContextForPrompt is empty for an empty result", () => {
    expect(
      formatGraphContextForPrompt({
        impactedFiles: [],
        symbols: [],
        edges: [],
        coverage: 0,
      }),
    ).toBe("");
  });
});

// ── embedding client resolution ─────────────────────────────────────────────
describe("resolveEmbeddingClient", () => {
  it("returns an injected client verbatim regardless of mode", async () => {
    const fake = new FakeEmbeddingClient();
    await expect(
      resolveEmbeddingClient("/repo", { client: fake }),
    ).resolves.toBe(fake);
    await expect(
      resolveEmbeddingClient("/repo", { client: fake, mode: "off" }),
    ).resolves.toBe(fake);
  });

  it("mode: off always returns null, even with a gateway key present", async () => {
    await expect(
      resolveEmbeddingClient("/repo", { mode: "off", hasKey: () => true }),
    ).resolves.toBeNull();
  });

  describe("mode: gateway", () => {
    it("returns null when no gateway key is available", async () => {
      await expect(
        resolveEmbeddingClient("/repo", {
          mode: "gateway",
          hasKey: () => false,
        }),
      ).resolves.toBeNull();
    });

    it("builds a gateway client when a key is present", async () => {
      const client = await resolveEmbeddingClient("/repo", {
        mode: "gateway",
        hasKey: () => true,
      });
      expect(client?.providerId).toBe("openai/text-embedding-3-small");
      expect(client?.dimensions).toBe(1536);
    });
  });

  describe("mode: ollama", () => {
    it("returns the Ollama tier's client when it resolves one", async () => {
      const fake = new FakeEmbeddingClient();
      const client = await resolveEmbeddingClient("/repo", {
        mode: "ollama",
        createOllamaClient: async () => fake,
      });
      expect(client).toBe(fake);
    });

    it("returns null (no fallback to gateway) when Ollama is unavailable", async () => {
      const client = await resolveEmbeddingClient("/repo", {
        mode: "ollama",
        createOllamaClient: async () => null,
        hasKey: () => true, // a gateway key existing must NOT matter in explicit mode
      });
      expect(client).toBeNull();
    });
  });

  describe("mode: onnx", () => {
    it("returns the ONNX tier's client when it resolves one", async () => {
      const fake = new FakeEmbeddingClient();
      const client = await resolveEmbeddingClient("/repo", {
        mode: "onnx",
        createOnnxClient: async () => fake,
      });
      expect(client).toBe(fake);
    });

    it("returns null (no fallback to gateway) when ONNX is unavailable", async () => {
      const client = await resolveEmbeddingClient("/repo", {
        mode: "onnx",
        createOnnxClient: async () => null,
        hasKey: () => true,
      });
      expect(client).toBeNull();
    });
  });

  describe("mode: auto", () => {
    it("tries Ollama first and short-circuits before ONNX or the gateway", async () => {
      const ollama = new FakeEmbeddingClient();
      const createOnnxClient = vi.fn(async () => new FakeEmbeddingClient());
      const client = await resolveEmbeddingClient("/repo", {
        mode: "auto",
        createOllamaClient: async () => ollama,
        createOnnxClient,
        hasKey: () => true,
      });
      expect(client).toBe(ollama);
      expect(createOnnxClient).not.toHaveBeenCalled();
    });

    it("falls through to ONNX when Ollama is unavailable", async () => {
      const onnx = new FakeEmbeddingClient();
      const client = await resolveEmbeddingClient("/repo", {
        mode: "auto",
        createOllamaClient: async () => null,
        createOnnxClient: async () => onnx,
        hasKey: () => true,
      });
      expect(client).toBe(onnx);
    });

    it("falls through to the gateway when neither Ollama nor ONNX is available", async () => {
      const client = await resolveEmbeddingClient("/repo", {
        mode: "auto",
        createOllamaClient: async () => null,
        createOnnxClient: async () => null,
        hasKey: () => true,
      });
      expect(client?.providerId).toBe("openai/text-embedding-3-small");
    });

    it("returns null when nothing is available anywhere in the chain", async () => {
      const client = await resolveEmbeddingClient("/repo", {
        mode: "auto",
        createOllamaClient: async () => null,
        createOnnxClient: async () => null,
        hasKey: () => false,
      });
      expect(client).toBeNull();
    });
  });
});
