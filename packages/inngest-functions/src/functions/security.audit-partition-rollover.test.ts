import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: async (
    fn: (tx: { execute: typeof mocks.execute }) => Promise<unknown>,
  ) => fn({ execute: mocks.execute }),
}));
vi.mock("../logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
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
await import("./security.audit-partition-rollover");
const step = { run: async (_name: string, fn: () => Promise<unknown>) => fn() };
const result = {
  created: ["security_events_2026_10"],
  dropped: [],
  expiredDefaultRows: 0,
  hasExpiredDefaultRows: false,
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
