import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncPriceBookFromSources: vi.fn(),
  createFunction: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  syncPriceBookFromSources: mocks.syncPriceBookFromSources,
  nextPriceBookBoundary: (at: Date) =>
    new Date(Math.ceil((at.getTime() + 1) / 3_600_000) * 3_600_000),
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("./cost.price-book-reprice", () => ({
  PRICE_BOOK_BACKDATED_EVENT: "cost/price-book.backdated",
}));

type Handler = (ctx: {
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: (label: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
let handler: Handler | null = null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (_opts: unknown, t: typeof trigger, fn: Handler) => {
    trigger = t;
    handler = fn;
    return [{}];
  },
);

await import("./cost.price-book-sync");

const sendEvent = vi.fn(async () => {});
const step = {
  run: (_: string, fn: () => Promise<unknown>) => fn(),
  sendEvent,
};

const RESULT = {
  written: 0,
  unchanged: 40,
  renamed: 0,
  deferred: 0,
  superseded: 0,
  retired: 0,
  coldStart: false,
  hasBackdatedRows: false,
  models: 10,
  counts: {},
  failures: [],
  held: [],
};

describe("cost.price-book-sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T01:20:00.000Z"));
    mocks.syncPriceBookFromSources.mockReset().mockResolvedValue(RESULT);
    sendEvent.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("runs hourly and writes rows effective from the next hour", async () => {
    expect(trigger?.cron).toBe("0 * * * *");
    await handler!({ step });
    expect(mocks.syncPriceBookFromSources).toHaveBeenCalledWith({
      effectiveFrom: new Date("2026-09-15T02:00:00.000Z"),
    });
  });

  it("requests a re-roll after a backdated write", async () => {
    mocks.syncPriceBookFromSources.mockResolvedValue({
      ...RESULT,
      written: 40,
      unchanged: 0,
      coldStart: true,
      hasBackdatedRows: true,
    });
    const out = await handler!({ step });
    expect(sendEvent).toHaveBeenCalledWith("request-reprice", {
      name: "cost/price-book.backdated",
      data: {},
    });
    expect(out).toMatchObject({ written: 40, repriceRequested: true });
  });

  it("requests nothing when the write was not backdated", async () => {
    mocks.syncPriceBookFromSources.mockResolvedValue({
      ...RESULT,
      written: 3,
      coldStart: false,
    });
    const out = await handler!({ step });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(out).toMatchObject({ repriceRequested: false });
  });

  it("requests nothing when a cold book holds no floored row", async () => {
    mocks.syncPriceBookFromSources.mockResolvedValue({
      ...RESULT,
      written: 3,
      coldStart: true,
      hasBackdatedRows: false,
    });
    await handler!({ step });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  // The recovery half. A manual `--apply` can commit floored rows and fail to
  // dispatch the event, and an hourly sync of the now-correct book writes
  // nothing. Keyed on `written`, this sync asked for nothing, so the runs
  // those floored rows can now price stayed blank for ever with nothing left
  // that would ever ask again. Keyed on the book, it asks until the
  // cold-start window closes.
  it("requests a re-roll for floored rows an earlier run wrote, though this run wrote nothing", async () => {
    mocks.syncPriceBookFromSources.mockResolvedValue({
      ...RESULT,
      written: 0,
      unchanged: 352,
      coldStart: true,
      hasBackdatedRows: true,
    });
    const out = await handler!({ step });
    expect(sendEvent).toHaveBeenCalledWith("request-reprice", {
      name: "cost/price-book.backdated",
      data: {},
    });
    expect(out).toMatchObject({ written: 0, repriceRequested: true });
  });
});
