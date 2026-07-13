import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  selectEvalRunCostRollup: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/telemetry", () => ({
  selectEvalRunCostRollup: mocks.selectEvalRunCostRollup,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { evalRunListHandler } from "./eval.run.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const NOW = new Date("2026-01-01T00:00:00Z");
const DONE = new Date("2026-01-01T00:05:00Z");

// A page row shaped exactly as the handler's select projection returns it.
function pageRow(over: Record<string, unknown> = {}) {
  return {
    runId: "evr_1",
    datasetName: "Support QA",
    datasetSlug: "support-qa",
    datasetPublicId: "evd_1",
    name: "Nightly",
    target: { kind: "model", model: "anthropic/claude-opus-4.8" },
    judgeModel: "openai/gpt-5",
    status: "completed",
    itemCount: 10,
    completedCount: 10,
    failedCount: 0,
    avgScore: "0.91",
    passThreshold: "0.7",
    createdAt: NOW,
    completedAt: DONE,
    ...over,
  };
}

/**
 * Build a tx whose `.select(projection)` dispatches by the projected keys:
 *   - `{ id }`         → dataset lookup (terminates at `.limit`)
 *   - `{ n }`          → a count() query (terminates at `.where`)
 *   - anything else    → the paginated page (terminates at `.offset`)
 * `counts` is drained FIFO for successive count() queries: [total, allTime].
 */
function makeTx(opts: {
  dataset?: unknown[];
  page: unknown[];
  counts: number[];
}) {
  const counts = [...opts.counts];
  return {
    select: (projection: Record<string, unknown>) => {
      if ("id" in projection && Object.keys(projection).length === 1) {
        return {
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(opts.dataset ?? []) }),
          }),
        };
      }
      if ("n" in projection) {
        return {
          from: () => ({
            where: () => Promise.resolve([{ n: counts.shift() ?? 0 }]),
          }),
        };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({ offset: () => Promise.resolve(opts.page) }),
              }),
            }),
          }),
        }),
      };
    },
  };
}

describe("eval.run.list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectEvalRunCostRollup.mockResolvedValue(new Map());
  });

  function runWith(tx: unknown) {
    mocks.withTenantDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
  }

  it("maps a page row, coerces numerics, and returns total + allTimeTotal", async () => {
    mocks.selectEvalRunCostRollup.mockResolvedValue(
      new Map([
        ["evr_1", { costUsdMicros: 500, inputTokens: 1000, outputTokens: 400 }],
      ]),
    );
    runWith(makeTx({ page: [pageRow()], counts: [1, 3] }));

    const out = await evalRunListHandler(
      { sortBy: "created", sortDir: "desc", limit: 25, offset: 0 },
      CTX,
    );

    expect(out.total).toBe(1);
    expect(out.allTimeTotal).toBe(3);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toMatchObject({
      runId: "evr_1",
      datasetId: "evd_1",
      datasetName: "Support QA",
      datasetSlug: "support-qa",
      name: "Nightly",
      target: {
        kind: "model",
        model: "anthropic/claude-opus-4.8",
        agentSlug: null,
      },
      avgScore: 0.91,
      passThreshold: 0.7,
      costUsdMicros: 500,
      inputTokens: 1000,
      outputTokens: 400,
      createdAt: NOW.toISOString(),
      completedAt: DONE.toISOString(),
    });
  });

  it("normalizes an agent target and a null avgScore / completedAt", async () => {
    runWith(
      makeTx({
        page: [
          pageRow({
            target: { kind: "agent", agentSlug: "support-bot" },
            avgScore: null,
            completedAt: null,
          }),
        ],
        counts: [1, 1],
      }),
    );
    const out = await evalRunListHandler(
      { sortBy: "created", sortDir: "desc", limit: 25, offset: 0 },
      CTX,
    );
    expect(out.runs[0]?.target).toEqual({
      kind: "agent",
      model: null,
      agentSlug: "support-bot",
    });
    expect(out.runs[0]?.avgScore).toBeNull();
    expect(out.runs[0]?.completedAt).toBeNull();
  });

  it("returns an empty page with zero cost and correct totals", async () => {
    runWith(makeTx({ page: [], counts: [0, 5] }));
    const out = await evalRunListHandler(
      { sortBy: "created", sortDir: "desc", limit: 25, offset: 0 },
      CTX,
    );
    expect(out.runs).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.allTimeTotal).toBe(5);
    // No run ids → the rollup helper is still invoked but with an empty set.
    expect(mocks.selectEvalRunCostRollup).toHaveBeenCalledWith([]);
  });

  it("defaults cost/tokens to zero when the ClickHouse rollup throws", async () => {
    mocks.selectEvalRunCostRollup.mockRejectedValue(
      new Error("clickhouse down"),
    );
    runWith(makeTx({ page: [pageRow()], counts: [1, 1] }));
    const out = await evalRunListHandler(
      { sortBy: "score", sortDir: "desc", limit: 25, offset: 0 },
      CTX,
    );
    expect(out.runs[0]?.costUsdMicros).toBe(0);
    expect(out.runs[0]?.inputTokens).toBe(0);
    expect(out.runs[0]?.outputTokens).toBe(0);
  });

  it("resolves a datasetPublicId to its id before listing", async () => {
    runWith(
      makeTx({
        dataset: [{ id: "uuid-dataset-1" }],
        page: [pageRow()],
        counts: [1, 1],
      }),
    );
    const out = await evalRunListHandler(
      {
        datasetPublicId: "evd_1",
        sortBy: "created",
        sortDir: "desc",
        limit: 25,
        offset: 0,
      },
      CTX,
    );
    expect(out.runs).toHaveLength(1);
  });

  it("throws a 404 when the datasetPublicId does not resolve", async () => {
    runWith(makeTx({ dataset: [], page: [], counts: [0, 0] }));
    await expect(
      evalRunListHandler(
        {
          datasetPublicId: "evd_missing",
          sortBy: "created",
          sortDir: "desc",
          limit: 25,
          offset: 0,
        },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
