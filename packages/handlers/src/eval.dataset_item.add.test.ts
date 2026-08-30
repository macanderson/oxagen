import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { evalDatasetItemAddHandler } from "./eval.dataset_item.add";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeTx(
  datasetRow: { id: string; publicId: string; itemCount: number } | null,
  updatedItemCount: number | null,
): TxLike {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(datasetRow ? [datasetRow] : []),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue(
              updatedItemCount != null ? [{ itemCount: updatedItemCount }] : [],
            ),
        }),
      }),
    }),
  };
}

describe("eval.dataset.item.add handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bulk-inserts items and bumps the dataset item count", async () => {
    const DATASET = { id: "uuid-1", publicId: "eds_ABC", itemCount: 2 };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, 5)),
    );
    const out = await evalDatasetItemAddHandler(
      {
        datasetPublicId: "eds_ABC",
        items: [
          { input: "q1", metadata: {} },
          { input: "q2", expectedOutput: "a2", metadata: {} },
          { input: "q3", metadata: {} },
        ],
      },
      CTX,
    );
    expect(out).toEqual({ datasetId: "eds_ABC", added: 3, itemCount: 5 });
  });

  it("falls back to a computed item count when the update returns no row", async () => {
    const DATASET = { id: "uuid-1", publicId: "eds_ABC", itemCount: 2 };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, null)),
    );
    const out = await evalDatasetItemAddHandler(
      { datasetPublicId: "eds_ABC", items: [{ input: "q1", metadata: {} }] },
      CTX,
    );
    expect(out.itemCount).toBe(3);
  });

  it("throws a 404 when the dataset does not exist", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(null, null)),
    );
    await expect(
      evalDatasetItemAddHandler(
        {
          datasetPublicId: "eds_missing",
          items: [{ input: "q1", metadata: {} }],
        },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
