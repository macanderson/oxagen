import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  isUniqueViolation: vi.fn(),
  chSelect: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    isUniqueViolation: mocks.isUniqueViolation,
  };
});

vi.mock("@oxagen/telemetry", () => ({ chSelect: mocks.chSelect }));

import { schema } from "@oxagen/database";
import { evalDatasetFromTracesHandler } from "./eval.dataset.from_traces";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

/**
 * `selectResults` supplies one row set per expected `tx.select()` call, in
 * call order (the handler may call it once, or twice when the metered-filter
 * query comes back empty and it falls back to unfiltered recent messages).
 * The dataset insert is distinguished from the items insert by comparing the
 * real `schema` table reference the handler passes to `tx.insert(...)`.
 */
function makeTx(
  datasetInsertResult: unknown[] | Error,
  selectResults: unknown[][],
): TxLike {
  const insertMock = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.evalDatasets) {
      const returning =
        datasetInsertResult instanceof Error
          ? vi.fn().mockRejectedValue(datasetInsertResult)
          : vi.fn().mockResolvedValue(datasetInsertResult);
      return { values: vi.fn().mockReturnValue({ returning }) };
    }
    // eval_dataset_items insert: awaited directly, no .returning().
    return { values: vi.fn().mockResolvedValue(undefined) };
  });

  const selectMock = vi.fn();
  for (const rows of selectResults) {
    selectMock.mockReturnValueOnce(makeSelectChain(rows));
  }

  const updateMock = vi.fn().mockReturnValue({
    set: vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  });

  return { insert: insertMock, select: selectMock, update: updateMock };
}

const DATASET_ROW = { id: "uuid-1", publicId: "eds_TRACE", slug: "traces-ds" };

describe("eval.dataset.from_traces handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isUniqueViolation.mockReturnValue(false);
  });

  it("captures dataset items from metered turns matched directly", async () => {
    mocks.chSelect.mockResolvedValue({
      data: [{ id: "conv_1" }, { id: "conv_2" }],
    });
    const messageRows = [
      {
        id: "msg_1",
        conversationId: "conv_1",
        content: "hi",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "msg_2",
        conversationId: "conv_2",
        content: "yo",
        createdAt: new Date("2026-01-01T00:01:00Z"),
      },
    ];
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([DATASET_ROW], [messageRows])),
    );

    const out = await evalDatasetFromTracesHandler(
      {
        name: "Traces DS",
        capabilityName: "send_message",
        sinceHours: 24,
        limit: 50,
      },
      CTX,
    );

    expect(out).toEqual({
      datasetId: "eds_TRACE",
      publicId: "eds_TRACE",
      slug: "traces-ds",
      itemCount: 2,
    });
  });

  it("falls back to unfiltered recent messages when chSelect fails (metered lookup degrades to empty)", async () => {
    mocks.chSelect.mockRejectedValue(new Error("clickhouse unreachable"));
    const messageRows = [
      {
        id: "msg_1",
        conversationId: "conv_x",
        content: "fallback",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    // Only one select() call is expected: turnIds is empty, so
    // selectUserMessages(turnIds.length > 0) === selectUserMessages(false) is
    // the *only* query — there is no second "fallback" call in this path.
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([DATASET_ROW], [messageRows])),
    );

    const out = await evalDatasetFromTracesHandler(
      { name: "Fallback DS", sinceHours: 24, limit: 50 },
      CTX,
    );

    expect(out.itemCount).toBe(1);
    expect(out.datasetId).toBe("eds_TRACE");
  });

  it("re-queries unfiltered when the metered-filtered query matches zero messages", async () => {
    mocks.chSelect.mockResolvedValue({ data: [{ id: "conv_1" }] });
    const fallbackRows = [
      {
        id: "msg_9",
        conversationId: "conv_other",
        content: "recent",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    // First select() call (metered filter) returns nothing; second call
    // (unfiltered fallback, triggered because turnIds.length > 0 but rows
    // came back empty) returns the fallback rows.
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([DATASET_ROW], [[], fallbackRows])),
    );

    const out = await evalDatasetFromTracesHandler(
      {
        name: "Traces DS",
        capabilityName: "send_message",
        sinceHours: 24,
        limit: 50,
      },
      CTX,
    );

    expect(out.itemCount).toBe(1);
  });

  it("throws a 409 when the slug collides with an existing dataset", async () => {
    mocks.chSelect.mockResolvedValue({ data: [] });
    mocks.isUniqueViolation.mockReturnValue(true);
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx(new Error("duplicate key"), [[]])),
    );

    await expect(
      evalDatasetFromTracesHandler(
        { name: "Traces DS", slug: "traces-ds", sinceHours: 24, limit: 50 },
        CTX,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already exists"),
    });
  });
});
