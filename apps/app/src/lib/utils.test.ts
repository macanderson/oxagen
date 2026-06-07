/**
 * utils.test.ts — unit tests for cn, formatCents, formatDate.
 */
import { describe, it, expect } from "vitest";
import { cn, formatCents, formatDate } from "./utils";

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
});
