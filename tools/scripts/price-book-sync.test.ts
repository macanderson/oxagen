/**
 * price-book-sync's pure edges: the flag parser, the effective instant a run
 * defaults to, the report, and the target line that never prints a credential
 * — plus the repricing request a manual `--apply` owes whenever it backdated
 * rows.
 */
import { describe, expect, it, vi } from "vitest";
import {
  describeTarget,
  type Flags,
  needsReprice,
  parseFlags,
  reportLines,
  runPriceBookSync,
} from "./price-book-sync";

const NOW = new Date("2026-09-14T17:42:31.123Z");

describe("parseFlags", () => {
  // The NEXT top of the hour, the same instant the hourly job uses. The run
  // instant was read before the catalogs and the transaction, so a frame
  // rolled up in between was priced against a row the run then closed behind
  // it. A future boundary cannot be observed early, and because it is still
  // ahead, a re-run within the hour may correct it in place: syncPriceBook
  // refuses a same-instant rewrite only once that instant is in force.
  it("is a dry run effective from the next hour boundary by default", () => {
    const flags = parseFlags([], NOW);
    expect(flags.apply).toBe(false);
    expect(flags.effectiveFrom.toISOString()).toBe("2026-09-14T18:00:00.000Z");
  });

  // A boundary only seconds ahead cannot hold through the refresh, so a run
  // in the last minutes of an hour takes the hour after.
  it("skips a boundary too close to hold through the refresh", () => {
    const flags = parseFlags([], new Date("2026-09-14T17:58:00.000Z"));
    expect(flags.effectiveFrom.toISOString()).toBe("2026-09-14T19:00:00.000Z");
  });

  it("takes --apply and an explicit --effective-from", () => {
    const flags = parseFlags(
      ["--apply", "--effective-from=2026-10-01T00:00:00Z"],
      NOW,
    );
    expect(flags.apply).toBe(true);
    expect(flags.effectiveFrom.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  // A list price that starts in the past reprices settled runs on their next
  // rollup, and the sync cannot catch it for a key with no open row.
  it("refuses an --effective-from in the past", () => {
    expect(() =>
      parseFlags(["--effective-from=2026-09-14T00:00:00Z"], NOW),
    ).toThrow(/must not be in the past/);
  });

  it("refuses an unparseable instant and an unknown flag", () => {
    expect(() => parseFlags(["--effective-from=yesterday"], NOW)).toThrow(
      /RFC 3339/,
    );
    expect(() => parseFlags(["--force"], NOW)).toThrow(/unknown flag/);
  });

  it("takes --resend-reprice", () => {
    const flags = parseFlags(["--resend-reprice"], NOW);
    expect(flags.resendReprice).toBe(true);
    expect(flags.apply).toBe(false);
  });
});

describe("reportLines", () => {
  it("prints one line per seed with its price and unit", () => {
    const lines = reportLines([
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        modelAliases: [],
        region: null,
        tokenClass: "input_uncached",
        unit: "token",
        currency: "USD",
        microsPerMillion: 3_000_000n,
        effectiveFrom: NOW,
        effectiveTo: null,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /anthropic\s+claude-sonnet-5\s+input_uncached\s+3000000 micros\/1M token/,
    );
  });
});

describe("describeTarget", () => {
  it("names the host, port and database and never the password", () => {
    expect(
      describeTarget("postgres://oxagen:s3cret@localhost:5433/oxagen"),
    ).toBe("localhost:5433/oxagen");
    expect(describeTarget("postgres://u:p@db.internal/oxagen")).toBe(
      "db.internal:5432/oxagen",
    );
  });

  it("says so when the url is unset or unparseable", () => {
    expect(describeTarget(undefined)).toBe("(DATABASE_URL unset)");
    expect(describeTarget("not a url")).toBe("(DATABASE_URL unparseable)");
  });
});

// The half of a manual apply that used to be missing. A cold or partly-filled
// book backdates a newly discovered key to an instant before every frame, so
// the write prices runs that have already sealed with a blank or `estimated`
// cost — and the nightly sweep will not revisit them, because their
// `rolled_up_at` is already after their seal. The hourly job asks for those
// runs to be re-rolled; this script wrote the same rows and only printed a
// report, and the next hourly sync then found the book correct, wrote nothing
// and asked for nothing, so the costs stayed blank permanently.
describe("runPriceBookSync", () => {
  const FROM = new Date("2026-09-14T18:00:00.000Z");
  const flags = (over: Partial<Flags> = {}): Flags => ({
    apply: true,
    offline: true,
    effectiveFrom: FROM,
    resendReprice: false,
    ...over,
  });
  const writing = (
    result: Partial<{ written: number; unchanged: number; coldStart: boolean }>,
  ) =>
    vi.fn().mockResolvedValue({
      written: 0,
      unchanged: 0,
      coldStart: false,
      ...result,
    });

  it("requests the repricing exactly once after a backdated apply", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runPriceBookSync(flags(), {
      send,
      log: () => {},
      write: writing({ written: 12, coldStart: true }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: "cost/price-book.backdated",
      data: {},
    });
  });

  // A dry run wrote nothing, so there is nothing to reprice against — and it
  // must never dispatch work an operator only asked to preview.
  it("dispatches nothing on a dry run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runPriceBookSync(flags({ apply: false }), { send, log: () => {} });
    expect(send).not.toHaveBeenCalled();
  });

  // An apply against a book that is already correct writes nothing, and a
  // forward-dated write prices nothing that has already run.
  it("dispatches nothing when the apply wrote nothing", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runPriceBookSync(flags(), {
      send,
      log: () => {},
      write: writing({ written: 0, unchanged: 340, coldStart: true }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the write was not backdated", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await runPriceBookSync(flags(), {
      send,
      log: () => {},
      write: writing({ written: 7, coldStart: false }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  // Nowhere to send it is a failed run, not a quiet one: the prices are in
  // force and the runs they price are still blank, which reads as a success
  // to anyone watching the report alone.
  it("fails loudly when the event cannot be dispatched", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ECONNREFUSED :8288"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runPriceBookSync(flags(), {
        send,
        log: () => {},
        write: writing({ written: 12, coldStart: true }),
      }),
    ).rejects.toMatchObject({
      code: "price_book_reprice_request_failed",
      name: "RepriceRequestError",
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // The recovery path the RepriceRequestError message promises: a prior
  // --apply committed the write but the dispatch failed, and a plain
  // --apply re-run would read that same book back as already correct
  // (written: 0) and ask for nothing. --resend-reprice skips the sync and
  // the write entirely and only re-dispatches, so the write helper must
  // never be called.
  it("--resend-reprice re-dispatches without syncing or writing", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    await runPriceBookSync(flags({ resendReprice: true }), {
      send,
      log: () => {},
      write,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: "cost/price-book.backdated",
      data: {},
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("--resend-reprice fails loudly when the event cannot be dispatched", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ECONNREFUSED :8288"));
    const write = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runPriceBookSync(flags({ resendReprice: true }), {
        send,
        log: () => {},
        write,
      }),
    ).rejects.toMatchObject({
      code: "price_book_reprice_request_failed",
      name: "RepriceRequestError",
    });
    expect(write).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("needsReprice", () => {
  it("is the same test the hourly job makes", () => {
    expect(needsReprice({ apply: true, coldStart: true, written: 1 })).toBe(
      true,
    );
    expect(needsReprice({ apply: false, coldStart: true, written: 1 })).toBe(
      false,
    );
    expect(needsReprice({ apply: true, coldStart: false, written: 1 })).toBe(
      false,
    );
    expect(needsReprice({ apply: true, coldStart: true, written: 0 })).toBe(
      false,
    );
  });
});
