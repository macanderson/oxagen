import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeEndedGauPeriods: vi.fn(),
  resumePendingGauSettlements: vi.fn(),
  createFunction: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  closeEndedGauPeriods: mocks.closeEndedGauPeriods,
  resumePendingGauSettlements: mocks.resumePendingGauSettlements,
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

let definition: { config: unknown; trigger: unknown; handler: Handler } | null =
  null;
mocks.createFunction.mockImplementation(
  (config: unknown, trigger: unknown, handler: Handler) => {
    definition = { config, trigger, handler };
    return [{}];
  },
);

await import("./billing.gau-close");

/** Runs each step at once and records its name. */
function makeStep(names: string[]) {
  return {
    run: async (name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      return fn();
    },
  };
}

describe("billing.gau-close", () => {
  beforeEach(() => {
    mocks.closeEndedGauPeriods.mockReset();
    mocks.resumePendingGauSettlements.mockReset();
  });

  it("is registered as billing.gau-close, retried 3 times, at ten past every hour", () => {
    expect(definition?.config).toEqual({ id: "billing.gau-close", retries: 3 });
    expect(definition?.trigger).toEqual({ cron: "10 * * * *" });
  });

  it("closes ended periods before it resumes pending settlements, one step per page", async () => {
    const order: string[] = [];
    mocks.closeEndedGauPeriods.mockImplementation(async () => {
      order.push("close");
      return { processed: 3, nextCursor: null };
    });
    mocks.resumePendingGauSettlements.mockImplementation(async () => {
      order.push("resume");
      return { processed: 2, nextCursor: null };
    });
    const names: string[] = [];

    const result = await definition!.handler({ step: makeStep(names) });

    expect(order).toEqual(["close", "resume"]);
    expect(names).toEqual([
      "closeEndedGauPeriods-0",
      "resumePendingGauSettlements-0",
    ]);
    expect(result).toEqual({ closed: 3, resumed: 2 });
  });

  it("walks each step's pages, passing the cursor each page returned", async () => {
    mocks.closeEndedGauPeriods
      .mockResolvedValueOnce({ processed: 100, nextCursor: "b-100" })
      .mockResolvedValueOnce({ processed: 100, nextCursor: "b-200" })
      .mockResolvedValueOnce({ processed: 7, nextCursor: null });
    mocks.resumePendingGauSettlements
      .mockResolvedValueOnce({ processed: 100, nextCursor: "s-100" })
      .mockResolvedValueOnce({ processed: 0, nextCursor: null });
    const names: string[] = [];

    const result = await definition!.handler({ step: makeStep(names) });

    expect(mocks.closeEndedGauPeriods.mock.calls.map((c) => c[0])).toEqual([
      null,
      "b-100",
      "b-200",
    ]);
    expect(
      mocks.resumePendingGauSettlements.mock.calls.map((c) => c[0]),
    ).toEqual([null, "s-100"]);
    expect(names).toEqual([
      "closeEndedGauPeriods-0",
      "closeEndedGauPeriods-1",
      "closeEndedGauPeriods-2",
      "resumePendingGauSettlements-0",
      "resumePendingGauSettlements-1",
    ]);
    expect(result).toEqual({ closed: 207, resumed: 100 });
  });

  it("uses a replayed page's checkpoint rather than running it again", async () => {
    mocks.closeEndedGauPeriods.mockResolvedValue({
      processed: 0,
      nextCursor: null,
    });
    mocks.resumePendingGauSettlements.mockResolvedValue({
      processed: 0,
      nextCursor: null,
    });
    const checkpoint = { processed: 100, nextCursor: "b-100" };
    const step = {
      run: async (name: string, fn: () => Promise<unknown>) =>
        name === "closeEndedGauPeriods-0" ? checkpoint : fn(),
    };

    await definition!.handler({ step });

    expect(mocks.closeEndedGauPeriods).toHaveBeenCalledOnce();
    expect(mocks.closeEndedGauPeriods).toHaveBeenCalledWith("b-100");
  });
});
