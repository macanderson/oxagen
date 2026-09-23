import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { NonRetriableError } from "@oxagen/functions";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: async (
    fn: (tx: { execute: typeof mocks.execute }) => Promise<unknown>,
  ) => fn({ execute: mocks.execute }),
}));
vi.mock("../logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));
type StepCtx = {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
};
let handler: (ctx: StepCtx) => Promise<unknown>;
let registration: {
  options: { concurrency: { limit: number } };
  trigger: { cron: string };
};
vi.mock("../create-function", () => ({
  createFunction: (
    options: typeof registration.options,
    trigger: typeof registration.trigger,
    callback: typeof handler,
  ) => {
    registration = { options, trigger };
    handler = callback;
    return [{}];
  },
}));
const { AuditPartitionMaintenanceError } = await import(
  "./security.audit-partition-rollover"
);
const step = { run: async (_name: string, fn: () => Promise<unknown>) => fn() };
const result = {
  created: ["security_events_2026_10"],
  dropped: [],
  expiredDefaultRows: 0,
  hasExpiredDefaultRows: false,
  skipped: [],
  hasSkippedPartitions: false,
};
const skippedMonth = {
  partition: "security_events_2026_09",
  phase: "create" as const,
  sqlstate: "P0001",
  reason:
    "Audit partition name security_events_2026_09 belongs to a different table",
  pendingRows: 2,
};

describe("audit partition maintenance cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue([{ result }]);
  });
  it("runs daily with one durable maintenance call and no caller-selected dates", async () => {
    expect(registration.trigger.cron).toBe("0 3 * * *");
    expect(registration.options.concurrency.limit).toBe(1);
    await expect(handler({ step })).resolves.toEqual(result);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]![0]);
    expect(query.sql.trim()).toBe(
      "SELECT security.maintain_audit_partitions() AS result",
    );
    expect(query.params).toEqual([]);
  });
  it("reports a bounded DEFAULT retention backlog", async () => {
    mocks.execute.mockResolvedValue([
      {
        result: {
          ...result,
          expiredDefaultRows: 10000,
          hasExpiredDefaultRows: true,
        },
      },
    ]);
    await handler({ step });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
  it("keeps the committed months and fails the run when work was skipped", async () => {
    mocks.execute.mockResolvedValue([
      {
        result: {
          ...result,
          created: ["security_events_2026_10", "security_events_2026_11"],
          dropped: ["security_events_2018_09"],
          skipped: [skippedMonth],
          hasSkippedPartitions: true,
        },
      },
    ]);
    // The failure is final: a retry would skip the same step again, so the
    // durable runner is told not to. The typed error rides as the cause.
    const failure = await handler({ step }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(NonRetriableError);
    expect((failure as NonRetriableError).cause).toBeInstanceOf(
      AuditPartitionMaintenanceError,
    );
    expect((failure as NonRetriableError).message).toContain(
      "security_events_2026_09 (create, P0001)",
    );
    // The months that succeeded are reported before the run fails.
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0]![0]).toMatchObject({
      created: ["security_events_2026_10", "security_events_2026_11"],
      dropped: ["security_events_2018_09"],
    });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0]![0]).toEqual({ skipped: [skippedMonth] });
  });
  it("names the skipped work and its stuck rows on the thrown error", () => {
    const error = new AuditPartitionMaintenanceError([skippedMonth]);
    expect(error.code).toBe("audit_partition_maintenance_incomplete");
    expect(error.message).toContain("security_events_2026_09 (create, P0001)");
    expect(error.skipped[0]?.pendingRows).toBe(2);
  });
  it("refuses a maintenance result whose skipped entry is malformed", async () => {
    mocks.execute.mockResolvedValue([
      {
        result: {
          ...result,
          skipped: [{ ...skippedMonth, phase: "vacuum" }],
          hasSkippedPartitions: true,
        },
      },
    ]);
    await expect(handler({ step })).rejects.toThrow();
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it("propagates failed maintenance so the durable runner retries", async () => {
    mocks.execute.mockRejectedValue(new Error("partitioning unavailable"));
    await expect(handler({ step })).rejects.toThrow("partitioning unavailable");
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it("refuses missing or malformed database evidence", async () => {
    mocks.execute.mockResolvedValue([]);
    await expect(handler({ step })).rejects.toThrow();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
