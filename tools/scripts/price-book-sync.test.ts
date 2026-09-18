/**
 * price-book-sync's pure edges: the flag parser, the effective instant a run
 * defaults to, the report, and the target line that never prints a credential.
 */
import { describe, expect, it } from "vitest";
import { describeTarget, parseFlags, reportLines } from "./price-book-sync";

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
