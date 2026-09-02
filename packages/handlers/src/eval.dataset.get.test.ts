import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { evalDatasetGetHandler } from "./eval.dataset.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = { select: ReturnType<typeof vi.fn> };

function makeChain(limitResult: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(limitResult),
  };
}

/**
 * Builds a tx whose `.select()` returns each queued chain in order, matching
 * the handler's query sequence: dataset lookup, then (optionally) the cursor
 * lookup, then the items page.
 */
function makeTx(sequence: unknown[][]): TxLike {
  const selectMock = vi.fn();
  for (const rows of sequence) {
    selectMock.mockReturnValueOnce(makeChain(rows));
  }
  return { select: selectMock };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const DATASET_ROW = {
  publicId: "eds_ABC",
  name: "Acme Eval",
  slug: "acme-eval",
  description: null,
  source: "manual",
  itemCount: 2,
  createdAt: NOW,
  id: "uuid-dataset-1",
};

describe("eval.dataset.get handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the dataset and its first page of items", async () => {
    const ITEM_ROW = {
      publicId: "edi_1",
      input: "What is 2+2?",
      expectedOutput: "4",
      metadata: { source: "manual" },
    };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([[DATASET_ROW], [ITEM_ROW]])),
    );
    const out = await evalDatasetGetHandler(
      { datasetPublicId: "eds_ABC", limit: 50 },
      CTX,
    );
    expect(out.dataset).toEqual({
      datasetId: "eds_ABC",
      name: "Acme Eval",
      slug: "acme-eval",
      description: null,
      source: "manual",
      itemCount: 2,
      createdAt: NOW.toISOString(),
    });
    expect(out.items).toEqual([
      {
        itemId: "edi_1",
        input: "What is 2+2?",
        expectedOutput: "4",
        metadata: { source: "manual" },
      },
    ]);
    expect(out.nextCursor).toBeNull();
  });

  it("throws a 404 when the dataset does not exist", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([[]])),
    );
    await expect(
      evalDatasetGetHandler({ datasetPublicId: "eds_missing", limit: 50 }, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sets nextCursor and trims the page when more items remain", async () => {
    const rows = [
      { publicId: "edi_1", input: "a", expectedOutput: null, metadata: {} },
      { publicId: "edi_2", input: "b", expectedOutput: null, metadata: {} },
    ];
    // limit=1 + 1 overfetch => 2 rows returned, hasMore true, page trimmed to 1.
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([[DATASET_ROW], rows])),
    );
    const out = await evalDatasetGetHandler(
      { datasetPublicId: "eds_ABC", limit: 1 },
      CTX,
    );
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBe("edi_1");
  });

  it("resolves the cursor to an item id before paginating", async () => {
    const cursorRow = { id: "uuid-item-cursor" };
    const pageRows = [
      { publicId: "edi_3", input: "c", expectedOutput: null, metadata: {} },
    ];
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([[DATASET_ROW], [cursorRow], pageRows])),
    );
    const out = await evalDatasetGetHandler(
      { datasetPublicId: "eds_ABC", limit: 50, cursor: "edi_2" },
      CTX,
    );
    expect(out.items).toEqual([
      { itemId: "edi_3", input: "c", expectedOutput: null, metadata: {} },
    ]);
  });
});
