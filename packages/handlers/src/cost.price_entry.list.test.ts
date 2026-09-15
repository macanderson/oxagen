import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import type { PriceEntry } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import { createPriceEntryListHandler } from "./cost.price_entry.list";
import { ctx, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-14T15:00:00.000Z");

function entry(over: Partial<PriceEntry> = {}): PriceEntry {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: ["claude-sonnet-5-20260601"],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...over,
  };
}

function harness(entries: PriceEntry[]) {
  const listPriceEntries = vi.fn(async () => entries);
  return {
    handler: createPriceEntryListHandler({ listPriceEntries, now: () => NOW }),
    listPriceEntries,
  };
}

describe("list_price_entries", () => {
  it("lists the book effective now when no instant is given", async () => {
    const h = harness([]);
    const out = await h.handler({}, ctx());
    expect(h.listPriceEntries).toHaveBeenCalledWith({ at: NOW });
    expect(out).toEqual({ at: NOW.toISOString(), entries: [] });
    expect(() => costPriceEntryList.output.parse(out)).not.toThrow();
  });

  it("lists the book effective at the instant asked for", async () => {
    const h = harness([]);
    await h.handler({ at: "2026-08-01T00:00:00.000Z" }, ctx());
    expect(h.listPriceEntries).toHaveBeenCalledWith({
      at: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("answers each entry with its price as integer micros and its window as instants", async () => {
    const h = harness([
      entry(),
      entry({
        id: "0192d4a8-7c1e-7a00-8000-0000000000e2",
        orgId: SCOPE.orgId,
        source: "negotiated",
        microsPerMillion: 2_500_000n,
        effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
      }),
    ]);
    const out = await h.handler({}, ctx());
    expect(out.entries).toEqual([
      {
        id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
        orgId: null,
        provider: "anthropic",
        model: "claude-sonnet-5",
        modelAliases: ["claude-sonnet-5-20260601"],
        region: null,
        tokenClass: "input_uncached",
        unit: "token",
        currency: "USD",
        microsPerMillion: "3000000",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveTo: null,
        source: "list",
      },
      expect.objectContaining({
        orgId: SCOPE.orgId,
        source: "negotiated",
        microsPerMillion: "2500000",
        effectiveTo: "2026-12-31T00:00:00.000Z",
      }),
    ]);
    expect(() => costPriceEntryList.output.parse(out)).not.toThrow();
  });
});
