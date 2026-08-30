import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  tierModelId: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/ai", () => ({ tierModelId: mocks.tierModelId }));

vi.mock("./event-client", () => ({ eventClient: { send: mocks.send } }));

import { evalRunStartHandler } from "./eval.run.start";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

function makeTx(
  datasetRow: { id: string; publicId: string; itemCount: number } | null,
  insertReturning: unknown[],
): TxLike {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(datasetRow ? [datasetRow] : []),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertReturning),
      }),
    }),
  };
}

describe("eval.run.start handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tierModelId.mockReturnValue("gateway/precise-model");
    mocks.send.mockResolvedValue(undefined);
  });

  it("inserts a pending run, enqueues the eval/run.start event, and returns the pending shape", async () => {
    const DATASET = {
      id: "uuid-dataset-1",
      publicId: "eds_ABC",
      itemCount: 10,
    };
    const RUN_ROW = { id: "uuid-run-1", publicId: "evr_XYZ" };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, [RUN_ROW])),
    );

    const out = await evalRunStartHandler(
      {
        datasetPublicId: "eds_ABC",
        target: { kind: "model" },
        passThreshold: 0.7,
      },
      CTX,
    );

    expect(out).toEqual({ runId: "evr_XYZ", status: "pending", itemCount: 10 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "eval/run.start",
      data: {
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        runId: "uuid-run-1",
        runPublicId: "evr_XYZ",
        datasetId: "uuid-dataset-1",
        maxItems: null,
      },
    });
  });

  it("caps itemCount at maxItems when it is lower than the dataset's item count", async () => {
    const DATASET = {
      id: "uuid-dataset-1",
      publicId: "eds_ABC",
      itemCount: 10,
    };
    const RUN_ROW = { id: "uuid-run-1", publicId: "evr_XYZ" };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, [RUN_ROW])),
    );

    const out = await evalRunStartHandler(
      {
        datasetPublicId: "eds_ABC",
        target: { kind: "model" },
        passThreshold: 0.7,
        maxItems: 3,
      },
      CTX,
    );

    expect(out.itemCount).toBe(3);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxItems: 3 }),
      }),
    );
  });

  it("uses the caller-supplied judgeModel instead of the precise tier default", async () => {
    const DATASET = { id: "uuid-dataset-1", publicId: "eds_ABC", itemCount: 5 };
    const RUN_ROW = { id: "uuid-run-1", publicId: "evr_XYZ" };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, [RUN_ROW])),
    );

    await evalRunStartHandler(
      {
        datasetPublicId: "eds_ABC",
        target: { kind: "model" },
        passThreshold: 0.7,
        judgeModel: "gateway/custom-judge",
      },
      CTX,
    );

    expect(mocks.tierModelId).not.toHaveBeenCalled();
  });

  it("throws a 404 when the dataset does not exist", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(null, [])),
    );

    await expect(
      evalRunStartHandler(
        {
          datasetPublicId: "eds_missing",
          target: { kind: "model" },
          passThreshold: 0.7,
        },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("throws a 422 when the dataset has no items", async () => {
    const DATASET = { id: "uuid-dataset-1", publicId: "eds_ABC", itemCount: 0 };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx(DATASET, [])),
    );

    await expect(
      evalRunStartHandler(
        {
          datasetPublicId: "eds_ABC",
          target: { kind: "model" },
          passThreshold: 0.7,
        },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
