// standing-context-price-store.test.ts — what the weekly price read hands the
// frame read and the book slice. The frame read and the slice are mocked:
// the arguments and the pricing of what they return are the behaviour under
// test, and a real ClickHouse or Postgres would prove nothing about either.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceEntry } from "./price-book";

const mocks = vi.hoisted(() => ({
  readObservedModels: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
  loadSlice: vi.fn(async (_slice: unknown): Promise<unknown[]> => []),
}));

vi.mock("@oxagen/telemetry", () => ({
  readObservedModels: mocks.readObservedModels,
}));

vi.mock("./price-book", async (importOriginal) => {
  const real = await importOriginal<typeof import("./price-book")>();
  return { ...real, loadPriceBookSliceInTenantScope: mocks.loadSlice };
});

import {
  readWeeklyContextPrice,
  WEEKLY_PRICE_READ_PAGE_SIZE,
} from "./standing-context-price-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const NOW = new Date("2026-09-27T12:00:00.000Z");
const SINCE = new Date("2026-09-20T12:00:00.000Z");
const UNTIL = new Date(NOW.getTime() - 1);
const RATE_CHANGE = new Date("2026-09-24T00:00:00.000Z");

function entry(
  overrides: Partial<PriceEntry> & Pick<PriceEntry, "id" | "tokenClass">,
): PriceEntry {
  return {
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...overrides,
  };
}

/** Input is $3 a million; reads are $0.30 before the change and $0.20 after. */
const BOOK: PriceEntry[] = [
  entry({ id: "pe_in", tokenClass: "input_uncached" }),
  entry({
    id: "pe_read_old",
    tokenClass: "cache_read",
    microsPerMillion: 300_000n,
    effectiveTo: RATE_CHANGE,
  }),
  entry({
    id: "pe_read_new",
    tokenClass: "cache_read",
    microsPerMillion: 200_000n,
    effectiveFrom: RATE_CHANGE,
  }),
];

type ReadArgs = {
  orgId: string;
  workspaceId?: string;
  since: Date;
  until?: Date;
  frameStores?: string;
  page?: { afterModel?: string; size: number };
  callBuckets?: boolean;
  boundariesFor: (models: readonly string[]) => Promise<readonly Date[]>;
};

/** A model whose week is one bucket of cache reads, as the read returns it. */
function readsOnly(model: string, calls: number) {
  return {
    model,
    provider: "anthropic",
    calls,
    tokens: 0,
    firstSeen: "2026-09-25T08:00:00.000Z",
    lastSeen: "2026-09-25T08:00:00.000Z",
    classes: [],
    callBuckets: [
      {
        calls,
        cacheReadCalls: calls,
        firstSeen: "2026-09-25T08:00:00.000Z",
      },
    ],
  };
}

/** A full page of models, m-0000 to m-0999, with one cache read each. */
function fullPage() {
  const rows: ReturnType<typeof readsOnly>[] = [];
  for (let i = 0; i < WEEKLY_PRICE_READ_PAGE_SIZE; i += 1)
    rows.push(readsOnly(`m-${String(i).padStart(4, "0")}`, 1));
  return rows;
}

/** A $3 input rate and a $0.30 read rate for each model asked for. */
async function bookFor(raw: unknown): Promise<PriceEntry[]> {
  const { models } = raw as { models: readonly string[] };
  return models.flatMap((model) => [
    entry({ id: `pe_in_${model}`, model, tokenClass: "input_uncached" }),
    entry({
      id: `pe_read_${model}`,
      model,
      tokenClass: "cache_read",
      microsPerMillion: 300_000n,
    }),
  ]);
}

beforeEach(() => {
  mocks.readObservedModels.mockReset();
  mocks.loadSlice.mockReset();
  mocks.loadSlice.mockResolvedValue(BOOK);
});

describe("readWeeklyContextPrice", () => {
  it("prices the week's calls by call time at the rate in force in each bucket", async () => {
    let boundaries: readonly Date[] = [];
    mocks.readObservedModels.mockImplementation(async (raw) => {
      const args = raw as ReadArgs;
      boundaries = await args.boundariesFor(["claude-sonnet-5"]);
      return [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 2_100,
          tokens: 0,
          firstSeen: "2026-09-21T08:00:00.000Z",
          lastSeen: "2026-09-26T08:00:00.000Z",
          classes: [],
          callBuckets: [
            {
              calls: 1_000,
              cacheReadCalls: 1_000,
              firstSeen: "2026-09-21T08:00:00.000Z",
            },
            {
              calls: 1_100,
              cacheReadCalls: 1_000,
              firstSeen: "2026-09-25T08:00:00.000Z",
            },
          ],
        },
      ];
    });

    // 1,000 reads at $0.30, 1,000 at $0.20, and 100 misses at $3 a million:
    // 300,000 + 200,000 + 300,000 micros for 1,000 tokens.
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toEqual({
      perThousandMicros: 800_000n,
      currency: "USD",
      requests: 2_100,
      since: SINCE,
    });
    const args = mocks.readObservedModels.mock.calls[0]?.[0] as ReadArgs;
    expect(args).toMatchObject({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      since: SINCE,
      until: UNTIL,
      // The calls per bucket, so each bucket's misses take its own input
      // rate (#4572 item 4).
      callBuckets: true,
      page: { size: WEEKLY_PRICE_READ_PAGE_SIZE },
    });
    expect(args.page?.afterModel).toBeUndefined();
    // Both frame stores: a wrapped agent's calls re-send the prefix too.
    expect(args.frameStores).toBeUndefined();
    expect(mocks.loadSlice).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      models: ["claude-sonnet-5"],
      from: SINCE,
      to: UNTIL,
    });
    expect(boundaries).toEqual([RATE_CHANGE]);
  });

  it("is null when the week made no call", async () => {
    mocks.readObservedModels.mockResolvedValue([]);
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toBeNull();
    expect(mocks.loadSlice).not.toHaveBeenCalled();
  });

  it("is null when the book prices none of the week's calls", async () => {
    mocks.readObservedModels.mockImplementation(async (raw) => {
      await (raw as ReadArgs).boundariesFor(["in-house-model"]);
      return [
        {
          model: "in-house-model",
          provider: null,
          calls: 50,
          tokens: 0,
          firstSeen: "2026-09-21T08:00:00.000Z",
          lastSeen: "2026-09-26T08:00:00.000Z",
          classes: [],
          callBuckets: [
            {
              calls: 50,
              cacheReadCalls: 0,
              firstSeen: "2026-09-21T08:00:00.000Z",
            },
          ],
        },
      ];
    });
    mocks.loadSlice.mockResolvedValue([]);
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toBeNull();
  });

  // #4572 item 8: the old quote left the unpriced calls out and priced the
  // rest, so the providers table printed a floor as the weekly price.
  it("is null when one of the week's calls has no rate in the book", async () => {
    mocks.readObservedModels.mockImplementation(async (raw) => {
      await (raw as ReadArgs).boundariesFor(["claude-sonnet-5", "local"]);
      return [readsOnly("claude-sonnet-5", 1_000), readsOnly("local", 1)];
    });
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toBeNull();
  });

  // #4572 item 5: the old read took one ranked page and dropped every model
  // past it, so this week read 300,000 micros over 1,000 requests.
  it("walks every page of models and prices them all", async () => {
    const first = fullPage();
    const second = [readsOnly("zz-model", 1_000)];
    mocks.loadSlice.mockImplementation(bookFor);
    mocks.readObservedModels.mockImplementation(async (raw) => {
      const args = raw as ReadArgs;
      const page = args.page?.afterModel === undefined ? first : second;
      await args.boundariesFor(page.map((row) => row.model));
      return page;
    });
    // 2,000 reads at $0.30 a million: 600,000 micros for 1,000 tokens.
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toEqual({
      perThousandMicros: 600_000n,
      currency: "USD",
      requests: 2_000,
      since: SINCE,
    });
    const calls = mocks.readObservedModels.mock.calls;
    const pages = calls.map((call) => (call[0] as ReadArgs).page);
    expect(pages).toEqual([
      { afterModel: undefined, size: WEEKLY_PRICE_READ_PAGE_SIZE },
      { afterModel: "m-0999", size: WEEKLY_PRICE_READ_PAGE_SIZE },
    ]);
    // Each page prices its models from its own slice of the book.
    expect(mocks.loadSlice).toHaveBeenCalledTimes(2);
    expect(mocks.loadSlice).toHaveBeenLastCalledWith(
      expect.objectContaining({ models: ["zz-model"] }),
    );
  });

  it("throws when a full page does not move the cursor forward", async () => {
    const page = fullPage();
    mocks.loadSlice.mockImplementation(bookFor);
    mocks.readObservedModels.mockImplementation(async (raw) => {
      await (raw as ReadArgs).boundariesFor(page.map((row) => row.model));
      return page;
    });
    await expect(readWeeklyContextPrice(SCOPE, NOW)).rejects.toThrow(
      /did not advance past "m-0999"/,
    );
  });
});
