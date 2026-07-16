/**
 * utils.test.ts — unit tests for cn, formatCents, formatDate, formatDateTime,
 * formatDateTimeWithSeconds, formatBytes, firstNameOf, truncate,
 * formatDuration.
 */
import { describe, it, expect } from "vitest";
import {
  cn,
  formatCents,
  formatCentsCompact,
  formatDate,
  formatDateTime,
  formatDateTimeWithSeconds,
  formatBytes,
  firstNameOf,
  truncate,
  formatDuration,
} from "./utils";

// ---------------------------------------------------------------------------
// cn — className merger
// ---------------------------------------------------------------------------

describe("cn", () => {
  it("returns empty string with no args", () => {
    expect(cn()).toBe("");
  });

  it("joins class strings", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("handles conditional classes (falsy omitted)", () => {
    expect(cn("base", false && "hidden", "active")).toBe("base active");
  });

  it("merges conflicting Tailwind classes (last wins)", () => {
    // tailwind-merge: p-2 and p-4 conflict, last wins
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("handles object syntax from clsx", () => {
    expect(cn({ visible: true, hidden: false })).toBe("visible");
  });

  it("handles array syntax", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("deduplicates identical Tailwind utilities", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles undefined and null gracefully", () => {
    expect(cn(undefined, null, "real")).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// formatCents — currency formatting
// ---------------------------------------------------------------------------

describe("formatCents", () => {
  it("formats 0 cents as $0.00", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats 100 cents as $1.00", () => {
    expect(formatCents(100)).toBe("$1.00");
  });

  it("formats 999 cents as $9.99", () => {
    expect(formatCents(999)).toBe("$9.99");
  });

  it("formats 100000 cents as $1,000.00", () => {
    expect(formatCents(100000)).toBe("$1,000.00");
  });

  it("formats negative values", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });

  it("formats fractional cents correctly (rounds)", () => {
    // 1 cent = $0.01; 50 cents = $0.50
    expect(formatCents(50)).toBe("$0.50");
  });

  it("accepts an explicit USD currency", () => {
    expect(formatCents(200, "USD")).toBe("$2.00");
  });
});

// ---------------------------------------------------------------------------
// formatCentsCompact — abbreviated currency for large balances
// ---------------------------------------------------------------------------

describe("formatCentsCompact", () => {
  it("keeps full cent precision below $10,000", () => {
    expect(formatCentsCompact(0)).toBe("$0.00");
    expect(formatCentsCompact(500)).toBe("$5.00");
    expect(formatCentsCompact(99999)).toBe("$999.99");
  });

  it("keeps a four-figure balance exact — 'about $1K' is not good enough when you're deciding whether to top up", () => {
    // Regression: the threshold used to be $1,000, so a real $1,003.59 balance
    // rendered as "$1K" — hiding whether the user had $1,000 or $1,499.
    expect(formatCentsCompact(100_359)).toBe("$1,003.59");
    expect(formatCentsCompact(999_999)).toBe("$9,999.99");
  });

  it("abbreviates large balances so they don't dominate the surface", () => {
    expect(formatCentsCompact(1_234_500)).toBe("$12.3K"); // $12,345
    expect(formatCentsCompact(120_000_000)).toBe("$1.2M"); // $1,200,000
    expect(formatCentsCompact(100_000_000)).toBe("$1M"); // $1,000,000
    expect(formatCentsCompact(500_000_000)).toBe("$5M"); // $5,000,000
  });

  it("abbreviates from the $10,000 boundary up", () => {
    // $10,000.00 = 1,000,000 cents → compact "$10K"
    expect(formatCentsCompact(1_000_000)).toBe("$10K");
  });

  it("is resilient to non-finite input", () => {
    expect(formatCentsCompact(Number.NaN)).toBe("$0.00");
    expect(formatCentsCompact(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

// ---------------------------------------------------------------------------
// formatDate — medium date format
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  it("returns '—' for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("formats a Date object", () => {
    // Use a fixed UTC date — medium format gives e.g. "Jun 1, 2026"
    const d = new Date("2026-06-01T12:00:00.000Z");
    const result = formatDate(d);
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/2026/);
  });

  it("formats an ISO string", () => {
    const result = formatDate("2026-01-15T00:00:00.000Z");
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2026/);
  });

  it("formats a date string without time component", () => {
    const result = formatDate("2026-12-25");
    expect(result).toMatch(/Dec/);
    expect(result).toMatch(/2026/);
  });

  it("returns the original string for an unparseable date string", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

// ---------------------------------------------------------------------------
// formatDateTime — date + hour:minute
// ---------------------------------------------------------------------------

describe("formatDateTime", () => {
  it("returns '—' for null/undefined", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("formats date + time with 2-digit hour/minute", () => {
    const result = formatDateTime(new Date("2026-01-05T14:03:00.000Z"));
    expect(result).toMatch(/Jan 5, 2026/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("returns the original string for an unparseable date string", () => {
    expect(formatDateTime("garbage")).toBe("garbage");
  });
});

// ---------------------------------------------------------------------------
// formatDateTimeWithSeconds — date + hour:minute:second
// ---------------------------------------------------------------------------

describe("formatDateTimeWithSeconds", () => {
  it("returns '—' for null/undefined", () => {
    expect(formatDateTimeWithSeconds(null)).toBe("—");
    expect(formatDateTimeWithSeconds(undefined)).toBe("—");
  });

  it("formats date + time + seconds", () => {
    const result = formatDateTimeWithSeconds(
      new Date("2026-01-05T14:03:07.000Z"),
    );
    expect(result).toMatch(/Jan 5, 2026/);
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// formatBytes — human-readable byte formatting
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats KB range with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats MB range with one decimal", () => {
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("formats GB range with one decimal", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("returns '—' for NaN/Infinity instead of 'NaN GB'", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// firstNameOf — the chat empty state's "Welcome, {firstName}!" greeting
// ---------------------------------------------------------------------------

describe("firstNameOf", () => {
  it("returns the first whitespace-separated token of a full name", () => {
    expect(firstNameOf("Mac Anderson")).toBe("Mac");
  });

  it("returns a single-token name unchanged", () => {
    expect(firstNameOf("Mac")).toBe("Mac");
  });

  it("takes only the first token of a multi-part name", () => {
    expect(firstNameOf("Ada King Lovelace")).toBe("Ada");
  });

  it("trims surrounding whitespace and collapses runs between tokens", () => {
    expect(firstNameOf("   Mac   Anderson  ")).toBe("Mac");
    expect(firstNameOf("\n\tMac\tAnderson")).toBe("Mac");
  });

  it("returns null for a missing name", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });

  it("returns null for an empty or whitespace-only name", () => {
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
  });

  it("returns null for an email — greeting someone by their address is worse than no name", () => {
    expect(firstNameOf("mac@oxagen.sh")).toBeNull();
    expect(firstNameOf("mac@oxagen.sh extra")).toBeNull();
  });

  it("keeps a real name even when a later token looks like an email", () => {
    expect(firstNameOf("Mac mac@oxagen.sh")).toBe("Mac");
  });
});

// ---------------------------------------------------------------------------
// truncate — ellipsis truncation
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns the string unchanged when at or under max", () => {
    expect(truncate("short", 40)).toBe("short");
  });

  it("truncates long strings, keeping total length at max", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// formatDuration — human duration from milliseconds
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats sub-second durations with 'ms' suffix", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("formats minutes + floored seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("returns '—' for NaN/Infinity instead of the literal 'NaNm NaNs'", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
    // A missing duration commonly arrives as `undefined` coerced through arithmetic.
    expect(formatDuration(undefined as unknown as number)).toBe("—");
  });
});
