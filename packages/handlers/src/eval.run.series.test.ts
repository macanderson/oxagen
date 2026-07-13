import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// getModel resolves a known model to a vendor; unknown models fall back to the
// id prefix. Stub it so the test is independent of the live catalog.
vi.mock("@oxagen/ai/catalog", () => ({
  getModel: (id: string) =>
    id === "anthropic/claude-opus-4.8" ? { vendor: "anthropic" } : undefined,
}));

import { evalRunSeriesHandler } from "./eval.run.series";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const B1 = new Date("2026-07-01T00:00:00Z");
const B2 = new Date("2026-07-02T00:00:00Z");

/**
 * Build a tx routing each `.select(projection)` to its queued result set by the
 * projected keys:
 *   - `{ id }`                       → dataset lookup (terminates at `.limit`)
 *   - has `runCount`, no `passRate`  → overall aggregate (terminates at `.orderBy`)
 *   - has `passRate`                 → per-model aggregate (terminates at `.orderBy`)
 *   - has `bucketStart` + `model`, no `runCount` → per-model points (`.orderBy`)
 */
function makeTx(opts: {
  dataset?: unknown[];
  overall: unknown[];
  modelAgg: unknown[];
  modelPoints: unknown[];
}) {
  return {
    select: (projection: Record<string, unknown>) => {
      if ("id" in projection && Object.keys(projection).length === 1) {
        return {
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(opts.dataset ?? []) }),
          }),
        };
      }
      let rows: unknown[];
      if ("passRate" in projection) rows = opts.modelAgg;
      else if ("runCount" in projection) rows = opts.overall;
      else rows = opts.modelPoints;
      return {
        from: () => ({
          where: () => ({
            groupBy: () => ({ orderBy: () => Promise.resolve(rows) }),
          }),
        }),
      };
    },
  };
}

describe("eval.run.series handler", () => {
  beforeEach(() => vi.clearAllMocks());

  function runWith(tx: unknown) {
    mocks.withTenantDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
  }

  it("buckets overall scores and coerces numerics to ISO + numbers", async () => {
    runWith(
      makeTx({
        overall: [
          { bucketStart: B1, avgScore: "0.90", runCount: "2" },
          { bucketStart: B2, avgScore: "0.80", runCount: "1" },
        ],
        modelAgg: [],
        modelPoints: [],
      }),
    );
    const out = await evalRunSeriesHandler({ bucket: "day" }, CTX);
    expect(out.overall).toEqual([
      { bucketStart: B1.toISOString(), avgScore: 0.9, runCount: 2 },
      { bucketStart: B2.toISOString(), avgScore: 0.8, runCount: 1 },
    ]);
  });

  it("builds a per-model breakdown with vendor, passRate, and points", async () => {
    runWith(
      makeTx({
        overall: [{ bucketStart: B1, avgScore: "0.90", runCount: "2" }],
        modelAgg: [
          {
            model: "anthropic/claude-opus-4.8",
            avgScore: "0.90",
            passRate: "1",
            runCount: "2",
          },
          {
            model: "openai/gpt-5",
            avgScore: "0.60",
            passRate: "0.5",
            runCount: "2",
          },
        ],
        modelPoints: [
          {
            model: "anthropic/claude-opus-4.8",
            bucketStart: B1,
            avgScore: "0.90",
          },
          { model: "openai/gpt-5", bucketStart: B1, avgScore: "0.55" },
          { model: "openai/gpt-5", bucketStart: B2, avgScore: "0.65" },
        ],
      }),
    );
    const out = await evalRunSeriesHandler({ bucket: "day" }, CTX);

    const anthropic = out.byModel.find(
      (m) => m.model === "anthropic/claude-opus-4.8",
    );
    expect(anthropic).toMatchObject({
      vendor: "anthropic",
      avgScore: 0.9,
      passRate: 1,
      runCount: 2,
    });
    expect(anthropic?.points).toEqual([
      { bucketStart: B1.toISOString(), avgScore: 0.9 },
    ]);

    // Unknown model → vendor falls back to the id prefix.
    const openai = out.byModel.find((m) => m.model === "openai/gpt-5");
    expect(openai?.vendor).toBe("openai");
    expect(openai?.passRate).toBe(0.5);
    expect(openai?.points).toHaveLength(2);
  });

  it("returns empty arrays when there are no completed runs", async () => {
    runWith(makeTx({ overall: [], modelAgg: [], modelPoints: [] }));
    const out = await evalRunSeriesHandler({ bucket: "week" }, CTX);
    expect(out.overall).toEqual([]);
    expect(out.byModel).toEqual([]);
  });

  it("resolves a datasetPublicId before aggregating", async () => {
    runWith(
      makeTx({
        dataset: [{ id: "uuid-dataset-1" }],
        overall: [{ bucketStart: B1, avgScore: "0.90", runCount: "1" }],
        modelAgg: [],
        modelPoints: [],
      }),
    );
    const out = await evalRunSeriesHandler(
      { datasetPublicId: "evd_1", bucket: "day" },
      CTX,
    );
    expect(out.overall).toHaveLength(1);
  });

  it("throws a 404 when the datasetPublicId does not resolve", async () => {
    runWith(
      makeTx({ dataset: [], overall: [], modelAgg: [], modelPoints: [] }),
    );
    await expect(
      evalRunSeriesHandler(
        { datasetPublicId: "evd_missing", bucket: "day" },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
