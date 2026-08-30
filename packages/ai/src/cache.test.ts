import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  getScope: vi.fn(),
  insertEvents: vi.fn(),
  embedText: vi.fn(),
  // Chainable tx capture handles.
  valuesSpy: vi.fn(),
  onConflictSpy: vi.fn(),
}));

// A thenable drizzle-query chain: every builder method returns the chain; each
// `await` shifts the next queued result off `queue`. Terminal-vs-intermediate
// doesn't matter — only awaited calls consume.
function makeTx(queue: unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const m of [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "update",
    "set",
    "insert",
  ]) {
    chain[m] = passthrough;
  }
  chain.values = (...args: unknown[]) => {
    mocks.valuesSpy(...args);
    return chain;
  };
  chain.onConflictDoUpdate = (...args: unknown[]) => {
    mocks.onConflictSpy(...args);
    return Promise.resolve(undefined);
  };
  // Make the chain awaitable — resolves to the next queued result.
  chain.then = (resolve: (v: unknown) => unknown) =>
    resolve(queue.shift() ?? []);
  return chain;
}

mocks.runInTenantScope.mockImplementation(
  async (_scope: unknown, fn: () => unknown) => fn(),
);
mocks.getScope.mockReturnValue(undefined);
mocks.insertEvents.mockResolvedValue(undefined);

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: {
    aiResponseCache: {
      id: "id",
      response: "response",
      usage: "usage",
      responseKind: "responseKind",
      embedding: "embedding",
      orgId: "orgId",
      workspaceId: "workspaceId",
      cacheKey: "cacheKey",
      deletedAt: "deletedAt",
      expiresAt: "expiresAt",
      model: "model",
      surface: "surface",
      createdAt: "createdAt",
      hitCount: "hitCount",
      lastHitAt: "lastHitAt",
      promptHash: "promptHash",
    },
  },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
  getScope: mocks.getScope,
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mocks.insertEvents }));
vi.mock("./embed", () => ({ embedText: mocks.embedText }));

// drizzle-orm operator helpers are called but their return values are never
// introspected by the chain mock, so stub them to opaque markers.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  gt: (...a: unknown[]) => ({ gt: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), {
    raw: () => ({}),
  }),
}));

import {
  buildCacheKey,
  cosineSimilarity,
  sha256Hex,
  readCache,
  writeCache,
  type CacheContext,
  type CacheOptions,
  type CachedUsage,
} from "./cache";

const CTX: CacheContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "ingestion",
  promptHash: "deadbeef",
  model: "openai/gpt",
  shapeHash: "shape1",
  promptText: "classify this",
};

function queueTx(...batches: unknown[][]) {
  // Every withTenantDb() call shares one queue so DB ops consume in order.
  const q: unknown[] = batches.slice();
  mocks.withTenantDb.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb(makeTx(q)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runInTenantScope.mockImplementation(
    async (_s: unknown, fn: () => unknown) => fn(),
  );
  mocks.getScope.mockReturnValue(undefined);
  mocks.insertEvents.mockResolvedValue(undefined);
});

describe("pure helpers", () => {
  it("sha256Hex is stable and hex", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });

  it("buildCacheKey changes when any field changes", () => {
    const base = buildCacheKey({
      promptHash: "p",
      model: "m",
      surface: "s",
      shapeHash: "h",
    });
    expect(
      buildCacheKey({
        promptHash: "p",
        model: "m",
        surface: "s",
        shapeHash: "h",
      }),
    ).toBe(base);
    expect(
      buildCacheKey({
        promptHash: "X",
        model: "m",
        surface: "s",
        shapeHash: "h",
      }),
    ).not.toBe(base);
    expect(
      buildCacheKey({
        promptHash: "p",
        model: "X",
        surface: "s",
        shapeHash: "h",
      }),
    ).not.toBe(base);
    expect(
      buildCacheKey({
        promptHash: "p",
        model: "m",
        surface: "X",
        shapeHash: "h",
      }),
    ).not.toBe(base);
    expect(
      buildCacheKey({
        promptHash: "p",
        model: "m",
        surface: "s",
        shapeHash: "X",
      }),
    ).not.toBe(base);
  });

  it("cosineSimilarity: identical=1, orthogonal=0, length-mismatch=0, zero=0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("readCache", () => {
  const OPTS: CacheOptions = { ttlSeconds: 3600 };

  it("returns an exact hit and emits ai.cache.hit", async () => {
    queueTx(
      [
        {
          id: "row1",
          response: { title: "Cached" },
          usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 42 },
          responseKind: "object",
          embedding: null,
        },
      ],
      [], // bumpHit update
    );
    const res = await readCache<{ title: string }>(CTX, OPTS);
    expect(res.hit).not.toBeNull();
    expect(res.hit?.value).toEqual({ title: "Cached" });
    expect(res.hit?.semantic).toBe(false);
    expect(res.hit?.similarity).toBe(1);
    expect(res.hit?.usage.costUsdMicros).toBe(42);
    const evt = mocks.insertEvents.mock.calls[0]![0][0] as Record<
      string,
      unknown
    >;
    expect(evt.event_type).toBe("ai.cache.hit");
    expect(evt.org_id).toBe(CTX.orgId);
    expect(mocks.embedText).not.toHaveBeenCalled();
  });

  it("returns a miss (no exact, semantic off) and emits ai.cache.miss", async () => {
    queueTx([]);
    const res = await readCache(CTX, OPTS);
    expect(res.hit).toBeNull();
    expect(
      (mocks.insertEvents.mock.calls[0]![0][0] as Record<string, unknown>)
        .event_type,
    ).toBe("ai.cache.miss");
    expect(mocks.embedText).not.toHaveBeenCalled();
  });

  it("finds a semantic hit above threshold", async () => {
    mocks.embedText.mockResolvedValue([1, 0, 0]);
    queueTx(
      [], // exact miss
      [
        {
          id: "row2",
          response: { title: "Near" },
          usage: {},
          responseKind: "object",
          embedding: [1, 0, 0],
        },
      ],
      [], // bumpHit
    );
    const res = await readCache<{ title: string }>(CTX, {
      ttlSeconds: 3600,
      semantic: true,
    });
    expect(res.hit?.value).toEqual({ title: "Near" });
    expect(res.hit?.semantic).toBe(true);
    expect(res.hit?.similarity).toBeCloseTo(1, 6);
    expect(
      (
        mocks.insertEvents.mock.calls.at(-1)?.[0][0] as
          | Record<string, unknown>
          | undefined
      )?.event_type,
    ).toBe("ai.cache.hit");
  });

  it("semantic miss below threshold returns the query embedding for reuse", async () => {
    mocks.embedText.mockResolvedValue([1, 0, 0]);
    queueTx(
      [], // exact miss
      [
        {
          id: "row3",
          response: {},
          usage: {},
          responseKind: "object",
          embedding: [0, 1, 0],
        },
      ],
    );
    const res = await readCache(CTX, {
      ttlSeconds: 3600,
      semantic: true,
      similarityThreshold: 0.9,
    });
    expect(res.hit).toBeNull();
    expect(res.queryEmbedding).toEqual([1, 0, 0]);
    expect(
      (
        mocks.insertEvents.mock.calls.at(-1)?.[0][0] as
          | Record<string, unknown>
          | undefined
      )?.event_type,
    ).toBe("ai.cache.miss");
  });

  it("swallows DB errors and reports a miss", async () => {
    mocks.withTenantDb.mockRejectedValue(new Error("db down"));
    const res = await readCache(CTX, OPTS);
    expect(res.hit).toBeNull();
  });

  it("scopes the read to the caller's tenant", async () => {
    queueTx([]);
    await readCache(CTX, OPTS);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId },
      expect.any(Function),
    );
  });
});

describe("writeCache", () => {
  // One factory for CachedUsage keeps a future field addition a one-line fix.
  const makeUsage = (overrides: Partial<CachedUsage> = {}): CachedUsage => ({
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsdMicros: 1,
    ...overrides,
  });

  it("inserts with a null embedding when semantic is off", async () => {
    queueTx([]); // insert resolves
    await writeCache(
      CTX,
      { ttlSeconds: 60 },
      { title: "X" },
      makeUsage({ cacheWriteTokens: 2 }),
    );
    expect(mocks.embedText).not.toHaveBeenCalled();
    const values = mocks.valuesSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.embedding).toBeNull();
    expect(values.cacheKey).toEqual(buildCacheKey(CTX));
    expect(mocks.onConflictSpy).toHaveBeenCalled();
  });

  it("embeds and stores a vector when semantic is on and none was precomputed", async () => {
    mocks.embedText.mockResolvedValue([0.1, 0.2]);
    queueTx([]);
    await writeCache(
      CTX,
      { ttlSeconds: 60, semantic: true },
      { title: "X" },
      makeUsage(),
    );
    expect(mocks.embedText).toHaveBeenCalledTimes(1);
    expect(
      (mocks.valuesSpy.mock.calls[0]![0] as Record<string, unknown>).embedding,
    ).toEqual([0.1, 0.2]);
  });

  it("reuses a precomputed embedding instead of embedding again", async () => {
    queueTx([]);
    await writeCache(
      CTX,
      { ttlSeconds: 60, semantic: true },
      { title: "X" },
      makeUsage(),
      "object",
      [9, 9],
    );
    expect(mocks.embedText).not.toHaveBeenCalled();
    expect(
      (mocks.valuesSpy.mock.calls[0]![0] as Record<string, unknown>).embedding,
    ).toEqual([9, 9]);
  });

  it("swallows write failures", async () => {
    mocks.withTenantDb.mockRejectedValue(new Error("boom"));
    await expect(
      writeCache(
        CTX,
        { ttlSeconds: 60 },
        {},
        makeUsage({ inputTokens: 0, outputTokens: 0, costUsdMicros: 0 }),
      ),
    ).resolves.toBeUndefined();
  });
});
