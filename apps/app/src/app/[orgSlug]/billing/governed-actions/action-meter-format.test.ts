/**
 * action-meter-format.test.ts — the honesty rules, tested at the level they are
 * decided.
 *
 * Every assertion here maps to a way the ADR-052 figures can be rendered
 * plausibly and wrongly:
 *   - a negotiated allowance shown as unlimited or blank
 *   - an unmeasured volume shown as zero
 *   - an absent retention policy shown as zero days or "forever"
 *   - a percentage of a zero allowance shown as 0% or 100%
 */

import { describe, it, expect } from "vitest";
import {
  NEGOTIATED_ALLOWANCE_LABEL,
  NOT_MEASURED_LABEL,
  NO_RETENTION_POLICY_LABEL,
  actionsPerRunSourceLabel,
  allowanceConsumedFraction,
  formatActions,
  formatBandRange,
  formatCreditsUsd,
  formatIncludedAllowance,
  formatIsoDate,
  formatPeriod,
  formatRetentionWindow,
  formatStoredGb,
  formatUsd,
  formatUsdFromMicros,
  formatUsdRate,
  runClassLabel,
  tierLabel,
} from "./action-meter-format";

describe("formatIncludedAllowance — negotiated is not unlimited", () => {
  it("renders null as words, not an infinity glyph and not a blank", () => {
    const out = formatIncludedAllowance(null);
    expect(out).toBe(NEGOTIATED_ALLOWANCE_LABEL);
    expect(out).not.toContain("∞");
    expect(out.trim()).not.toBe("");
    expect(out.toLowerCase()).not.toContain("unlimited");
  });

  it("renders a real allowance as a separated count", () => {
    expect(formatIncludedAllowance(1_000_000)).toBe("1,000,000 actions");
  });

  it("distinguishes zero from negotiated", () => {
    expect(formatIncludedAllowance(0)).toBe("0 actions");
    expect(formatIncludedAllowance(0)).not.toBe(NEGOTIATED_ALLOWANCE_LABEL);
  });
});

describe("formatStoredGb — not measured is not zero", () => {
  it("renders an unmeasured volume as its own phrase", () => {
    const out = formatStoredGb(null, false);
    expect(out).toBe(NOT_MEASURED_LABEL);
    expect(out).not.toContain("0");
  });

  it("keeps reporting 'not measured' even if a stray number is present", () => {
    // `storedGbMeasured` is the authority; a value alongside `false` is not a
    // measurement and must not be rendered as one.
    expect(formatStoredGb(12.5, false)).toBe(NOT_MEASURED_LABEL);
  });

  it("renders a genuine zero measurement as 0 GB", () => {
    expect(formatStoredGb(0, true)).toBe("0 GB");
  });

  it("renders a measured volume with GB units", () => {
    expect(formatStoredGb(42.125, true)).toBe("42.13 GB");
  });
});

describe("formatRetentionWindow — no policy is not zero days", () => {
  it("renders null as 'no policy pinned'", () => {
    expect(formatRetentionWindow(null)).toBe(NO_RETENTION_POLICY_LABEL);
    expect(formatRetentionWindow(null)).not.toContain("0");
    expect(formatRetentionWindow(null).toLowerCase()).not.toContain("forever");
  });

  it("adds a month approximation past two months", () => {
    expect(formatRetentionWindow(365)).toBe("365 days (~12 months)");
  });

  it("keeps short windows in days only", () => {
    expect(formatRetentionWindow(30)).toBe("30 days");
  });
});

describe("allowanceConsumedFraction", () => {
  it("is undefined (null) for a zero allowance, not 0% and not 100%", () => {
    expect(allowanceConsumedFraction(500, 0)).toBeNull();
  });

  it("clamps at 1 once the allowance is spent", () => {
    expect(allowanceConsumedFraction(2000, 1000)).toBe(1);
  });

  it("reports a partial fraction", () => {
    expect(allowanceConsumedFraction(250, 1000)).toBe(0.25);
  });
});

describe("money and count formatting", () => {
  it("renders credits as dollars at one cent per credit", () => {
    expect(formatCreditsUsd(12_345)).toBe("$123.45");
    expect(formatCreditsUsd(0)).toBe("$0.00");
  });

  it("renders a rate at four-decimal precision so $0.00 stays visible", () => {
    expect(formatUsdRate(0)).toBe("$0.00");
    expect(formatUsdRate(20)).toBe("$20.00");
    expect(formatUsdRate(0.08)).toBe("$0.08");
  });

  it("renders micro-USD token cost", () => {
    expect(formatUsdFromMicros(1_234_567)).toBe("$1.2346");
  });

  it("renders plain USD", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("separates action counts and floors fractions", () => {
    expect(formatActions(1_500_000)).toBe("1,500,000");
    expect(formatActions(3.9)).toBe("3");
  });

  it("returns an em dash for non-finite input rather than NaN", () => {
    expect(formatActions(Number.NaN)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatCreditsUsd(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsdRate(Number.NaN)).toBe("—");
    expect(formatUsdFromMicros(Number.NaN)).toBe("—");
  });
});

describe("formatBandRange", () => {
  it("renders a bounded band as an inclusive range", () => {
    expect(
      formatBandRange({
        minAnnualActions: 1_000_000,
        maxAnnualActions: 5_000_000,
      }),
    ).toBe("1,000,000 – 4,999,999");
  });

  it("renders the open top band with a plus", () => {
    expect(
      formatBandRange({ minAnnualActions: 5_000_000, maxAnnualActions: null }),
    ).toBe("5,000,000+");
  });
});

describe("date formatting", () => {
  it("renders an ISO instant as a UTC date", () => {
    expect(formatIsoDate("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
  });

  it("renders an unparseable instant as an em dash", () => {
    expect(formatIsoDate("not-a-date")).toBe("—");
  });

  it("renders a period as a range", () => {
    expect(
      formatPeriod({
        start: "2026-01-01T00:00:00.000Z",
        end: "2027-01-01T00:00:00.000Z",
      }),
    ).toBe("Jan 1, 2026 – Jan 1, 2027");
  });
});

describe("labels", () => {
  it("spells out where the actions-per-run ratio came from", () => {
    expect(actionsPerRunSourceLabel("caller_supplied")).toBe(
      "your measured ratio",
    );
    expect(actionsPerRunSourceLabel("run_class")).toBe(
      "the published ratio for this run class",
    );
  });

  it("maps run classes and tiers to human labels, falling back to the raw value", () => {
    expect(runClassLabel("multi_step")).toBe("Multi-step / coding");
    expect(runClassLabel("unknown_class")).toBe("unknown_class");
    expect(tierLabel("enterprise")).toBe("Enterprise");
    expect(tierLabel("bespoke")).toBe("bespoke");
  });
});
