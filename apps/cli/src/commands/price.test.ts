/**
 * `oxagen price set` / `oxagen price remove`. Pins the wire contract through
 * the apiPostOrThrow seam (route and body, including that `region` is always
 * null on a set and that an omitted alias list travels as `undefined`, never
 * `[]`), the flag validation that refuses before a request leaves the
 * process, the USD-per-million rendering, and the two output modes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPostOrThrow, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    apiPostOrThrow: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
    MockApiError,
  };
});

vi.mock("../lib/api.js", async () => {
  const real =
    await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...real, apiPostOrThrow, ApiError: MockApiError };
});

import { captureWriter } from "../lib/capture-writer";
import { priceRemove, priceSet, type PriceEntryRow } from "./price";

function row(over: Partial<PriceEntryRow> = {}): PriceEntryRow {
  return {
    id: "pe_1",
    orgId: "org_1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: "2400000",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
    effectiveTo: null,
    source: "negotiated",
    ...over,
  };
}

beforeEach(() => {
  process.exitCode = undefined;
  apiPostOrThrow.mockReset();
});

describe("price set", () => {
  const good = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "input_uncached",
    usdPerMillion: "2.40",
  };

  it("posts the contract body, region-agnostic, with aliases omitted as undefined", async () => {
    apiPostOrThrow.mockResolvedValue({ entry: row(), closed: null });
    const c = captureWriter();
    await priceSet(good, c.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("cost/price-entries/set", {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      region: null,
      modelAliases: undefined,
      usdPerMillion: 2.4,
      effectiveFrom: undefined,
    });
    expect(c.output()).toContain("$2.4 per 1M");
    expect(process.exitCode).toBeUndefined();
  });

  it("carries repeated --alias values and a normalised --effective-from", async () => {
    apiPostOrThrow.mockResolvedValue({ entry: row(), closed: null });
    const c = captureWriter();
    await priceSet(
      {
        ...good,
        alias: ["anthropic/claude-sonnet-5"],
        effectiveFrom: "2026-10-01T00:00:00Z",
      },
      c.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "cost/price-entries/set",
      expect.objectContaining({
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      }),
    );
  });

  it("names the row it closed, and says it was closed rather than overwritten", async () => {
    apiPostOrThrow.mockResolvedValue({
      entry: row(),
      closed: row({
        id: "pe_0",
        microsPerMillion: "3000000",
        effectiveTo: "2026-10-01T00:00:00.000Z",
      }),
    });
    const c = captureWriter();
    await priceSet(good, c.writer);
    expect(c.output()).toContain("$3 ");
    expect(c.output()).toContain("closed at 2026-10-01T00:00:00.000Z");
  });

  it("emits the exact payload as one line with --json", async () => {
    const payload = { entry: row(), closed: null };
    apiPostOrThrow.mockResolvedValue(payload);
    const c = captureWriter();
    await priceSet({ ...good, json: true }, c.writer);
    expect(JSON.parse(c.output())).toEqual(payload);
  });

  it.each([
    [
      { model: "m", tokenClass: "output", usdPerMillion: "1" },
      "--provider and --model",
    ],
    [{ ...good, tokenClass: "tokens" }, "Invalid --token-class"],
    [{ ...good, usdPerMillion: "2.4000001" }, "Invalid --usd-per-million"],
    [{ ...good, usdPerMillion: "-1" }, "Invalid --usd-per-million"],
    [{ ...good, effectiveFrom: "yesterday" }, "Invalid --effective-from"],
  ])("refuses %j before any request leaves", async (opts, message) => {
    const c = captureWriter();
    await priceSet(opts, c.writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(c.output()).toContain(message);
  });

  it("reports an API failure without throwing", async () => {
    apiPostOrThrow.mockRejectedValue(new MockApiError("forbidden", 403));
    const c = captureWriter();
    await priceSet(good, c.writer);
    expect(c.output()).toContain("forbidden");
  });
});

describe("price remove", () => {
  const good = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "input_uncached",
  };

  it("posts the key, with the region and instant the caller named", async () => {
    apiPostOrThrow.mockResolvedValue({
      at: "2026-11-01T00:00:00.000Z",
      closed: row({ effectiveTo: "2026-11-01T00:00:00.000Z" }),
      fallbackPriced: true,
    });
    const c = captureWriter();
    await priceRemove(
      { ...good, region: "eu-west-1", at: "2026-11-01T00:00:00Z" },
      c.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("cost/price-entries/remove", {
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      region: "eu-west-1",
      at: "2026-11-01T00:00:00.000Z",
    });
    expect(c.output()).toContain("returns to the list price from 2026-11-01");
  });

  // The class had no list or override price to fall back to: the "returns
  // to the list price" line would have been a false promise.
  it("warns UNPRICED instead of claiming a list-price fallback that does not exist", async () => {
    apiPostOrThrow.mockResolvedValue({
      at: "2026-11-01T00:00:00.000Z",
      closed: row({ effectiveTo: "2026-11-01T00:00:00.000Z" }),
      fallbackPriced: false,
    });
    const c = captureWriter();
    await priceRemove(good, c.writer);
    expect(c.output()).toContain("UNPRICED");
    expect(c.output()).not.toContain("returns to the list price");
  });

  // The gap the reviewer named: the handler now refuses to close a rate that
  // would leave the class unpriced unless the caller says to. The CLI must
  // surface the specific flag that resolves it, not a bare error.
  it("points at --confirm-unpriced when the close is refused for going unpriced", async () => {
    apiPostOrThrow.mockRejectedValue(
      new MockApiError(
        "Error 409 from cost/price-entries/remove: price_entry_close_would_unprice — " +
          "ending the negotiated rate for claude-sonnet-5 input_uncached would leave it UNPRICED",
        409,
      ),
    );
    const c = captureWriter();
    await priceRemove(good, c.writer);
    expect(c.output()).toContain("--confirm-unpriced");
  });

  it("carries --confirm-unpriced through as confirmUnpriced: true", async () => {
    apiPostOrThrow.mockResolvedValue({
      at: "2026-11-01T00:00:00.000Z",
      closed: row({ effectiveTo: "2026-11-01T00:00:00.000Z" }),
      fallbackPriced: false,
    });
    const c = captureWriter();
    await priceRemove({ ...good, confirmUnpriced: true }, c.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "cost/price-entries/remove",
      expect.objectContaining({ confirmUnpriced: true }),
    );
  });

  it("says when there was nothing open to end", async () => {
    apiPostOrThrow.mockResolvedValue({
      at: "2026-11-01T00:00:00.000Z",
      closed: null,
    });
    const c = captureWriter();
    await priceRemove(good, c.writer);
    expect(c.output()).toContain("nothing to end");
  });

  it.each([
    [{ model: "m", tokenClass: "output" }, "--provider and --model"],
    [{ ...good, tokenClass: "nope" }, "Invalid --token-class"],
    [{ ...good, at: "soon" }, "Invalid --at"],
  ])("refuses %j before any request leaves", async (opts, message) => {
    const c = captureWriter();
    await priceRemove(opts, c.writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(c.output()).toContain(message);
  });
});

describe("atomic price card", () => {
  const options = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "input_uncached",
    usdPerMillion: "3",
  };
  it("sends additional classes in one request", async () => {
    apiPostOrThrow.mockResolvedValue({
      entry: row(),
      closed: null,
      additionalEntries: [
        {
          entry: row({ tokenClass: "output", microsPerMillion: "15000000" }),
          closed: null,
        },
      ],
    });
    const c = captureWriter();
    await priceSet(
      { ...options, additionalRate: ["output=15", "cache_read=0.3"] },
      c.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledOnce();
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "cost/price-entries/set",
      expect.objectContaining({
        additionalRates: [
          { tokenClass: "output", usdPerMillion: 15 },
          { tokenClass: "cache_read", usdPerMillion: 0.3 },
        ],
      }),
    );
    expect(c.output()).toContain("output");
  });
  it.each(["output=-1", "input_uncached=4", "invalid=4", "output=4=5"])(
    "refuses invalid additional rate %s before the request",
    async (rate) => {
      await priceSet(
        { ...options, additionalRate: [rate] },
        captureWriter().writer,
      );
      expect(apiPostOrThrow).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    },
  );
});
