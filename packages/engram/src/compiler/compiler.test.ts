/**
 * Tests for the context compiler: packer, fusion, temporal retrieval,
 * layout, and the full compile() orchestrator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { createRecord } from "../record";
import { TemporalRetrievalEngine } from "../retrieval/temporal";
import {
  LexicalRetrievalEngine,
  type LexicalSearchFn,
} from "../retrieval/lexical";
import { fuseAndRank, DEFAULT_WEIGHTS } from "../retrieval/fusion";
import { pack } from "./packer";
import { buildLayout } from "./layout";
import { compile, computeBudget } from "./compile";
import { countTokens } from "./tokenizer";
import { compressRecord } from "./compress";
import type { Namespace, Provenance } from "../types";
import type { RetrievalCandidate, RetrievalEngine } from "../retrieval/types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeEpisodicRecord(
  event: string,
  salience = 0.5,
  createdAt = Date.now(),
) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: { detail: `details for ${event}` } },
    salience,
    confidence: 1.0,
    provenance: PROV,
  });
}

function makeSemanticRecord(fact: string, salience = 0.6) {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain: "test" },
    salience,
    confidence: 0.9,
    provenance: PROV,
  });
}

function makeProceduralRecord(rule: string) {
  return createRecord({
    kind: "procedural",
    namespace: NS,
    body: { rule, appliesTo: ["test"], successCount: 5, failureCount: 0 },
    salience: 1.0,
    confidence: 1.0,
    provenance: PROV,
  });
}

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

describe("countTokens", () => {
  it("returns a positive integer for non-empty text", () => {
    expect(countTokens("hello world", "gpt-4")).toBeGreaterThan(0);
  });

  it("returns 1 for empty string", () => {
    expect(countTokens("", "default")).toBe(1);
  });

  it("longer text produces more tokens", () => {
    const short = countTokens("hi", "gpt-4");
    const long = countTokens("a".repeat(1000), "gpt-4");
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

describe("compressRecord", () => {
  it("produces a summary under 200 characters", () => {
    const record = makeEpisodicRecord("tool_call");
    const compressed = compressRecord(record, 0.7);
    expect(compressed.summary.length).toBeLessThanOrEqual(200);
    expect(compressed.recordId).toBe(record.id);
    expect(compressed.score).toBe(0.7);
  });

  it("includes the event name for episodic records", () => {
    const record = makeEpisodicRecord("grep_search");
    const compressed = compressRecord(record, 0.5);
    expect(compressed.summary).toContain("grep_search");
  });

  it("includes the fact for semantic records", () => {
    const record = makeSemanticRecord("The API uses REST");
    const compressed = compressRecord(record, 0.6);
    expect(compressed.summary).toContain("The API uses REST");
  });
});

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

describe("fuseAndRank", () => {
  const makeCandidate = (
    id: string,
    score: number,
    source: RetrievalCandidate["source"],
  ): RetrievalCandidate => ({
    record: { ...makeEpisodicRecord("test"), id },
    score,
    source,
    tokenCost: 50,
  });

  it("deduplicates records appearing in multiple engines", () => {
    const engine1 = [makeCandidate("aaa", 0.9, "temporal")];
    const engine2 = [makeCandidate("aaa", 0.8, "vector")];
    const fused = fuseAndRank([engine1, engine2]);
    expect(fused).toHaveLength(1);
  });

  it("records in multiple engines score higher than single-engine", () => {
    const multiEngine = [makeCandidate("multi", 0.7, "temporal")];
    const multiEngine2 = [makeCandidate("multi", 0.6, "vector")];
    const singleEngine = [makeCandidate("single", 0.8, "temporal")];

    const fused = fuseAndRank([multiEngine, multiEngine2, singleEngine]);
    const multiRecord = fused.find((c) => c.record.id === "multi");
    const singleRecord = fused.find((c) => c.record.id === "single");
    expect(multiRecord!.score).toBeGreaterThan(singleRecord!.score);
  });

  it("returns results sorted by score descending", () => {
    const now = Date.now();
    // Give records different salience to ensure differentiation in final score
    const lowRecord = {
      ...makeEpisodicRecord("low"),
      id: "low-id",
      salience: 0.1,
      createdAt: now - 86400000,
    };
    const highRecord = {
      ...makeEpisodicRecord("high"),
      id: "high-id",
      salience: 0.9,
      createdAt: now,
    };
    const midRecord = {
      ...makeEpisodicRecord("mid"),
      id: "mid-id",
      salience: 0.5,
      createdAt: now - 3600000,
    };

    const engine: RetrievalCandidate[] = [
      { record: highRecord, score: 0.9, source: "temporal", tokenCost: 50 },
      { record: midRecord, score: 0.5, source: "temporal", tokenCost: 50 },
      { record: lowRecord, score: 0.2, source: "temporal", tokenCost: 50 },
    ];
    const fused = fuseAndRank([engine]);
    // The highest-score candidate should be first
    expect(fused[0]!.score).toBeGreaterThanOrEqual(fused[1]!.score);
    expect(fused[1]!.score).toBeGreaterThanOrEqual(fused[2]!.score);
  });
});

// ---------------------------------------------------------------------------
// Packer
// ---------------------------------------------------------------------------

describe("pack", () => {
  const budget = {
    total: 10000,
    reserved: { system: 500, procedural: 1000, volatile: 7000, working: 1500 },
  };

  it("never exceeds budget", () => {
    const candidates: RetrievalCandidate[] = Array.from(
      { length: 50 },
      (_, i) => ({
        record: makeEpisodicRecord(`event-${i}`),
        score: Math.random(),
        source: "temporal" as const,
        tokenCost: 200,
      }),
    );

    const result = pack({
      candidates,
      budget,
      pinnedRecords: [],
      diversityConstraint: 5,
      modelId: "gpt-4",
    });
    expect(result.tokenUsage.volatile).toBeLessThanOrEqual(
      budget.reserved.volatile,
    );
  });

  it("always includes pinned records regardless of budget", () => {
    const pinned = [makeProceduralRecord("Always validate input")];
    const result = pack({
      candidates: [],
      budget,
      pinnedRecords: pinned,
      diversityConstraint: 3,
      modelId: "gpt-4",
    });
    expect(result.included).toContain(pinned[0]);
  });

  it("prefers higher value-per-token records", () => {
    const highVpt: RetrievalCandidate = {
      record: makeEpisodicRecord("high-value"),
      score: 0.9,
      source: "temporal",
      tokenCost: 10,
    };
    const lowVpt: RetrievalCandidate = {
      record: makeEpisodicRecord("low-value"),
      score: 0.1,
      source: "temporal",
      tokenCost: 500,
    };

    const result = pack({
      candidates: [lowVpt, highVpt],
      budget,
      pinnedRecords: [],
      diversityConstraint: 10,
      modelId: "gpt-4",
    });
    // High VPT should be included
    expect(result.included.some((r) => r.id === highVpt.record.id)).toBe(true);
  });

  it("returns valid result for empty input", () => {
    const result = pack({
      candidates: [],
      budget,
      pinnedRecords: [],
      diversityConstraint: 3,
      modelId: "gpt-4",
    });
    expect(result.included).toHaveLength(0);
    expect(result.compressed).toHaveLength(0);
    expect(result.evicted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Temporal retrieval
// ---------------------------------------------------------------------------

describe("TemporalRetrievalEngine", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(async () => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    // Seed with some records
    const now = Date.now();
    await store.append({
      ...makeEpisodicRecord("recent", 0.8),
      createdAt: now - 60000,
    }); // 1 min ago
    await store.append({
      ...makeEpisodicRecord("old", 0.5),
      createdAt: now - 86400000,
    }); // 24h ago
    await store.append({
      ...makeEpisodicRecord("very-old", 0.3),
      createdAt: now - 604800000,
    }); // 7 days ago
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns candidates sorted by recency-weighted score", async () => {
    const engine = new TemporalRetrievalEngine(store);
    const results = await engine.retrieve({
      namespace: NS,
      taskDescription: "test",
      workingSet: [],
      recentEventIds: [],
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    // Recent record should score highest
    expect(results[0]!.score).toBeGreaterThan(
      results[results.length - 1]!.score,
    );
  });

  it("respects the limit parameter", async () => {
    const engine = new TemporalRetrievalEngine(store);
    const results = await engine.retrieve({
      namespace: NS,
      taskDescription: "test",
      workingSet: [],
      recentEventIds: [],
      limit: 1,
    });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe("buildLayout", () => {
  it("produces sections in correct position order", () => {
    const window = buildLayout({
      included: [makeEpisodicRecord("event"), makeSemanticRecord("fact")],
      compressed: [
        { recordId: "abc", summary: "test summary", score: 0.5, tokenCost: 10 },
      ],
      pinned: [makeProceduralRecord("rule 1")],
      systemPrompt: "You are a helpful assistant.",
      modelId: "gpt-4",
      tokenUsage: {
        system: 100,
        procedural: 50,
        volatile: 200,
        working: 0,
        total: 350,
        budgetRemaining: 9650,
      },
      metadata: {
        compiledAt: Date.now(),
        retrievalMs: 5,
        packingMs: 2,
        layoutMs: 1,
        totalMs: 8,
        candidatesRetrieved: 10,
        candidatesPacked: 2,
        candidatesCompressed: 1,
        candidatesEvicted: 7,
        retrievalFailures: 0,
        pinnedTruncated: 0,
        contentTruncated: 0,
      },
    });

    expect(window.sections.length).toBeGreaterThan(0);
    // Verify ordering: each section position is ≤ the next
    for (let i = 1; i < window.sections.length; i++) {
      expect(window.sections[i]!.position).toBeGreaterThanOrEqual(
        window.sections[i - 1]!.position,
      );
    }
  });

  it("system prompt is always position 0 and stable", () => {
    const window = buildLayout({
      included: [],
      compressed: [],
      pinned: [],
      systemPrompt: "System prompt here",
      modelId: "gpt-4",
      tokenUsage: {
        system: 50,
        procedural: 0,
        volatile: 0,
        working: 0,
        total: 50,
        budgetRemaining: 9950,
      },
      metadata: {
        compiledAt: Date.now(),
        retrievalMs: 0,
        packingMs: 0,
        layoutMs: 0,
        totalMs: 0,
        candidatesRetrieved: 0,
        candidatesPacked: 0,
        candidatesCompressed: 0,
        candidatesEvicted: 0,
        retrievalFailures: 0,
        pinnedTruncated: 0,
        contentTruncated: 0,
      },
    });
    const systemSection = window.sections.find((s) => s.type === "system");
    expect(systemSection).toBeDefined();
    expect(systemSection!.position).toBe(0);
    expect(systemSection!.stable).toBe(true);
  });

  it("computes cache hit rate correctly", () => {
    const window = buildLayout({
      included: [makeEpisodicRecord("event")],
      compressed: [],
      pinned: [makeProceduralRecord("always-on rule")],
      systemPrompt: "System",
      modelId: "gpt-4",
      tokenUsage: {
        system: 10,
        procedural: 30,
        volatile: 100,
        working: 0,
        total: 140,
        budgetRemaining: 9860,
      },
      metadata: {
        compiledAt: Date.now(),
        retrievalMs: 0,
        packingMs: 0,
        layoutMs: 0,
        totalMs: 0,
        candidatesRetrieved: 0,
        candidatesPacked: 0,
        candidatesCompressed: 0,
        candidatesEvicted: 0,
        retrievalFailures: 0,
        pinnedTruncated: 0,
        contentTruncated: 0,
      },
    });
    expect(window.cachePrefix.hitRate).toBeGreaterThan(0);
    expect(window.cachePrefix.hitRate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Full compile() orchestrator
// ---------------------------------------------------------------------------

describe("compile()", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(async () => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    const now = Date.now();
    // Seed store with test data
    await store.append({
      ...makeEpisodicRecord("tool_call", 0.6),
      createdAt: now - 10000,
    });
    await store.append({
      ...makeEpisodicRecord("decision", 0.8),
      createdAt: now - 5000,
    });
    await store.append({
      ...makeSemanticRecord("The API is RESTful", 0.7),
      createdAt: now - 30000,
    });
    await store.append({
      ...makeProceduralRecord("Validate all inputs"),
      createdAt: now - 60000,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it("produces a valid ContextWindow", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "Fix the login bug",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      {
        engines: [new TemporalRetrievalEngine(store)],
        store,
        systemPrompt: "You are a coding assistant.",
      },
    );

    expect(window.sections.length).toBeGreaterThan(0);
    expect(window.tokenUsage.total).toBeGreaterThan(0);
    expect(window.tokenUsage.total).toBeLessThanOrEqual(budget.total);
    expect(window.metadata.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("never exceeds the token budget", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "Do something",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      { engines: [new TemporalRetrievalEngine(store)], store },
    );
    expect(window.tokenUsage.total).toBeLessThanOrEqual(budget.total);
    expect(window.tokenUsage.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  it("includes pinned procedural records", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "test",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      { engines: [new TemporalRetrievalEngine(store)], store },
    );
    // The procedural record has salience 1.0 — should be in the pinned-rules section
    const proceduralSection = window.sections.find(
      (s) => s.type === "procedural",
    );
    if (proceduralSection) {
      expect(proceduralSection.content).toContain("Validate all inputs");
    }
  });

  it("records a rejecting engine in metadata.retrievalFailures and still returns", async () => {
    const budget = computeBudget("gpt-4");
    const failingEngine: RetrievalEngine = {
      name: "vector",
      retrieve: () => Promise.reject(new Error("vector store down")),
    };
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "test",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      {
        engines: [new TemporalRetrievalEngine(store), failingEngine],
        store,
      },
    );
    // No throw — degrades gracefully to the surviving engine's candidates.
    expect(window.sections.length).toBeGreaterThan(0);
    expect(window.metadata.retrievalFailures).toBe(1);
  });

  it("invokes onError with engine context when a retrieval engine rejects", async () => {
    const budget = computeBudget("gpt-4");
    const onError = vi.fn();
    const failingEngine: RetrievalEngine = {
      name: "vector",
      retrieve: () => Promise.reject(new Error("vector store down")),
    };
    await compile(
      {
        namespace: NS,
        taskDescription: "test",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      { engines: [failingEngine], store, onError },
    );
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "engine-retrieve", engine: "vector" }),
    );
  });

  it("records a rejecting pinned-record query in metadata.retrievalFailures and invokes onError", async () => {
    const budget = computeBudget("gpt-4");
    const onError = vi.fn();
    // Wrap the store so the pinned-record query rejects but retrieval works.
    const brokenStore = Object.create(store) as typeof store;
    brokenStore.query = () => Promise.reject(new Error("pinned query down"));
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "test",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      {
        engines: [new TemporalRetrievalEngine(store)],
        store: brokenStore,
        onError,
      },
    );
    expect(window.metadata.retrievalFailures).toBe(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "pinned-query" }),
    );
  });

  it("populates metadata timing fields", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "test",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      { engines: [new TemporalRetrievalEngine(store)], store },
    );
    expect(window.metadata.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(window.metadata.packingMs).toBeGreaterThanOrEqual(0);
    expect(window.metadata.layoutMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-engine recall — OXA-2061 regression: temporal-only vs the full engine
// set. A stale, low-salience record with an exact error-message match proves
// the gap Vector/Graph/Lexical wiring closes — temporal recency alone can
// never surface it (it's filtered out below TemporalRetrievalEngine's own
// minSalience: 0.2 floor before recency scoring even runs), while lexical
// exact-match recall (real DuckDB `searchLexical`, not mocked) finds it
// regardless of age or salience. This guards against the historical
// temporal-only production wiring that caused every turn to miss exact-match
// lexical evidence.
// ---------------------------------------------------------------------------

describe("compile() — multi-engine recall (OXA-2061)", () => {
  let store: DuckDBEpisodicStore;
  const STALE_ERROR_MESSAGE =
    "NullPointerException thrown at auth.ts:42 during token refresh";

  beforeEach(async () => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    const now = Date.now();

    // Below TemporalRetrievalEngine's minSalience: 0.2 floor AND 45 days
    // stale, so temporal recency ranking never even considers it a
    // candidate — but it's an exact, high-value lexical match (a stack
    // trace) that an agent debugging the same error should recall.
    await store.append({
      ...makeEpisodicRecord(
        "error_observed",
        0.05,
        now - 45 * 24 * 60 * 60 * 1000,
      ),
      body: {
        event: "error_observed",
        payload: { message: STALE_ERROR_MESSAGE },
      },
    });

    // A fresh, salient, unrelated record so temporal-only recall doesn't
    // return an empty window in both cases.
    await store.append({
      ...makeEpisodicRecord("tool_call", 0.9),
      createdAt: now - 1000,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  // Wires LexicalRetrievalEngine to the real DuckDB searchLexical() adapter
  // method rather than a stub.
  const realLexicalSearch: LexicalSearchFn = (query, opts) =>
    store.searchLexical(
      { org: opts.orgId, workspace: opts.workspaceId },
      query,
      opts.limit,
    );

  it("temporal-only recall misses a stale, low-salience exact-match memory", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "auth.ts:42 NullPointerException token refresh",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      { engines: [new TemporalRetrievalEngine(store)], store },
    );

    const joined = window.sections.map((s) => s.content).join("\n");
    expect(joined).not.toContain(STALE_ERROR_MESSAGE);
  });

  it("adding the lexical engine surfaces the exact-match memory that temporal recall missed", async () => {
    const budget = computeBudget("gpt-4");
    const window = await compile(
      {
        namespace: NS,
        taskDescription: "auth.ts:42 NullPointerException token refresh",
        workingSet: [],
        recentEventIds: [],
        modelId: "gpt-4",
      },
      budget,
      {
        engines: [
          new TemporalRetrievalEngine(store),
          new LexicalRetrievalEngine(store, realLexicalSearch),
        ],
        store,
      },
    );

    const joined = window.sections.map((s) => s.content).join("\n");
    expect(joined).toContain(STALE_ERROR_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// computeBudget
// ---------------------------------------------------------------------------

describe("computeBudget", () => {
  it("returns appropriate budget for OpenAI models", () => {
    const budget = computeBudget("gpt-4o");
    expect(budget.total).toBe(128000);
    expect(
      budget.reserved.system +
        budget.reserved.procedural +
        budget.reserved.volatile +
        budget.reserved.working,
    ).toBe(budget.total);
  });

  it("returns larger budget for Anthropic models", () => {
    const budget = computeBudget("claude-3.5-sonnet");
    expect(budget.total).toBe(200000);
  });

  it("returns default for unknown models", () => {
    const budget = computeBudget("unknown-model-xyz");
    expect(budget.total).toBe(128000);
  });
});
