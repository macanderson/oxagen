import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { evalDatasetListHandler } from "./eval.dataset.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = { select: ReturnType<typeof vi.fn> };

function makeTx(rows: unknown[]): TxLike {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  return { select: vi.fn().mockReturnValue(chain) };
}

describe("eval.dataset.list handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the mapped list of datasets", async () => {
    const NOW = new Date("2026-01-01T00:00:00Z");
    const ROW = {
      publicId: "eds_ABC",
      name: "Acme Eval",
      slug: "acme-eval",
      description: "desc",
      source: "manual",
      itemCount: 3,
      createdAt: NOW,
    };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([ROW])),
    );
    const out = await evalDatasetListHandler({}, CTX);
    expect(out.datasets).toHaveLength(1);
    expect(out.datasets[0]).toEqual({
      datasetId: "eds_ABC",
      name: "Acme Eval",
      slug: "acme-eval",
      description: "desc",
      source: "manual",
      itemCount: 3,
      createdAt: NOW.toISOString(),
    });
  });

  it("returns an empty list when there are no datasets", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([])),
    );
    const out = await evalDatasetListHandler({}, CTX);
    expect(out.datasets).toEqual([]);
  });
});
