import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[], calls: 0 }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    execute: async () => {
      state.calls += 1;
      return state.rows;
    },
  };
  return {
    ...real,
    withTenantDb: async (fn: (t: unknown) => unknown) => fn(tx),
  };
});

import { readWeeklyContextPrice } from "./standing-context-price-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const NOW = new Date("2026-09-27T12:00:00.000Z");

beforeEach(() => {
  state.rows = [];
  state.calls = 0;
});

describe("readWeeklyContextPrice", () => {
  it("quotes the week's read price times its requests for 1,000 tokens", async () => {
    // 0.3 micros a read token, 1,000 requests: 300,000 micros per 1,000 tokens.
    state.rows = [
      {
        requests: "1000",
        micros: "9000",
        tokens: "30000",
        currencies: "1",
        currency: "USD",
      },
    ];
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toEqual({
      perThousandMicros: 300_000n,
      currency: "USD",
      requests: 1_000,
      since: new Date("2026-09-20T12:00:00.000Z"),
    });
    expect(state.calls).toBe(1);
  });

  it("is null with no request, no priced cache read, or two currencies", async () => {
    const priced = {
      requests: "1000",
      micros: "9000",
      tokens: "30000",
      currencies: "1",
      currency: "USD",
    };
    for (const row of [
      { ...priced, requests: null },
      { ...priced, micros: null, tokens: null, currencies: "0", currency: null },
      { ...priced, currencies: "2" },
    ]) {
      state.rows = [row];
      await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toBeNull();
    }
    state.rows = [];
    await expect(readWeeklyContextPrice(SCOPE, NOW)).resolves.toBeNull();
  });

  it("reads a numeric sum with a fraction as its whole part", async () => {
    state.rows = [
      {
        requests: 10,
        micros: "9000.000",
        tokens: "30000.0",
        currencies: 1,
        currency: "USD",
      },
    ];
    const price = await readWeeklyContextPrice(SCOPE, NOW);
    expect(price?.perThousandMicros).toBe(3_000n);
  });
});
