import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  isUniqueViolation: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    isUniqueViolation: mocks.isUniqueViolation,
  };
});

import { evalDatasetCreateHandler } from "./eval.dataset.create";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = { insert: ReturnType<typeof vi.fn> };

function makeTx(returningResult: unknown[] | Error): TxLike {
  const returning =
    returningResult instanceof Error
      ? vi.fn().mockRejectedValue(returningResult)
      : vi.fn().mockResolvedValue(returningResult);
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning }),
    }),
  };
}

describe("eval.dataset.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isUniqueViolation.mockReturnValue(false);
  });

  it("creates a dataset and returns the mapped output shape", async () => {
    const ROW = { id: "uuid-1", publicId: "eds_ABC", slug: "acme-eval" };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([ROW])),
    );
    const out = await evalDatasetCreateHandler({ name: "Acme Eval" }, CTX);
    expect(out).toEqual({
      datasetId: "eds_ABC",
      publicId: "eds_ABC",
      slug: "acme-eval",
    });
  });

  it("derives a slug from the name when none is provided", async () => {
    const ROW = { id: "uuid-1", publicId: "eds_ABC", slug: "my-cool-dataset" };
    let capturedValues: Record<string, unknown> | undefined;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => {
        const tx: TxLike = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
              capturedValues = v;
              return { returning: vi.fn().mockResolvedValue([ROW]) };
            }),
          }),
        };
        return fn(tx);
      },
    );
    await evalDatasetCreateHandler({ name: "My Cool Dataset!!" }, CTX);
    expect(capturedValues?.slug).toBe("my-cool-dataset");
  });

  it("throws a 409 when the slug collides with an existing dataset", async () => {
    mocks.isUniqueViolation.mockReturnValue(true);
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx(new Error("duplicate key"))),
    );
    await expect(
      evalDatasetCreateHandler({ name: "Acme Eval", slug: "acme-eval" }, CTX),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already exists"),
    });
  });

  it("throws when the insert returns no row", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([])),
    );
    await expect(
      evalDatasetCreateHandler({ name: "Acme Eval" }, CTX),
    ).rejects.toThrow("eval_datasets insert failed");
  });
});
