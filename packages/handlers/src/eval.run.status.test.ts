import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { evalRunStatusHandler } from "./eval.run.status";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = { select: ReturnType<typeof vi.fn> };

function makeTx(rows: unknown[]): TxLike {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe("eval.run.status handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the mapped run status", async () => {
    const ROW = {
      publicId: "evr_ABC",
      status: "running",
      itemCount: 10,
      completedCount: 4,
      failedCount: 1,
      avgScore: "0.85",
      failureReason: null,
      workspaceId: CTX.workspaceId,
    };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([ROW])),
    );

    const out = await evalRunStatusHandler({ runPublicId: "evr_ABC" }, CTX);
    expect(out).toEqual({
      runId: "evr_ABC",
      status: "running",
      itemCount: 10,
      completedCount: 4,
      failedCount: 1,
      avgScore: 0.85,
      failureReason: null,
    });
  });

  it("returns a null avgScore when none has been computed yet", async () => {
    const ROW = {
      publicId: "evr_ABC",
      status: "pending",
      itemCount: 10,
      completedCount: 0,
      failedCount: 0,
      avgScore: null,
      failureReason: null,
      workspaceId: CTX.workspaceId,
    };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([ROW])),
    );

    const out = await evalRunStatusHandler({ runPublicId: "evr_ABC" }, CTX);
    expect(out.avgScore).toBeNull();
  });

  it("throws a 404 when the run does not exist", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([])),
    );

    await expect(
      evalRunStatusHandler({ runPublicId: "evr_missing" }, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws a 404 when the run belongs to a different workspace", async () => {
    const ROW = {
      publicId: "evr_ABC",
      status: "running",
      itemCount: 10,
      completedCount: 4,
      failedCount: 1,
      avgScore: null,
      failureReason: null,
      workspaceId: "ws_other",
    };
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([ROW])),
    );

    await expect(
      evalRunStatusHandler({ runPublicId: "evr_ABC" }, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });
});
