/**
 * price-book-sync's pure edges: the flag parser, the effective instant a run
 * defaults to, the report, and the target line that never prints a credential.
 */
import { describe, expect, it } from "vitest";
import { describeTarget, parseFlags, reportLines } from "./price-book-sync";

const NOW = new Date("2026-09-14T17:42:31.123Z");

describe("parseFlags", () => {
  // The run instant, not the top of the hour: a same-instant re-run that
  // changed a rate would rewrite a row frames earlier in the hour were priced
  // with, and syncPriceBook now refuses that, so the default must be an
  // instant no earlier run can have used.
  it("is a dry run effective from the run instant by default", () => {
    const flags = parseFlags([], NOW);
    expect(flags.apply).toBe(false);
    expect(flags.effectiveFrom.toISOString()).toBe("2026-09-14T17:42:31.123Z");
  });

  it("takes --apply and an explicit --effective-from", () => {
    const flags = parseFlags(
      ["--apply", "--effective-from=2026-10-01T00:00:00Z"],
      NOW,
    );
    expect(flags.apply).toBe(true);
    expect(flags.effectiveFrom.toISOString()).toBe("2026-10-01T00:00:00.000Z");
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
