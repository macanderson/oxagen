import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatDuration,
  formatTokens,
  formatCost,
  formatTimestamp,
  timeAgo,
  statusBadgeVariant,
} from "./format";

describe("formatDuration", () => {
  it("returns em-dash for null", () => {
    expect(formatDuration(null)).toBe("—");
  });
  it("returns em-dash for NaN/Infinity (not 'NaNms')", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
  });
  it("formats sub-second as ms", () => {
    expect(formatDuration(800)).toBe("800ms");
  });
  it("formats seconds with two decimals", () => {
    expect(formatDuration(4000)).toBe("4.00s");
    expect(formatDuration(1500)).toBe("1.50s");
  });
  it("formats minutes + seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("formatTokens", () => {
  it("returns empty string when both null", () => {
    expect(formatTokens(null, null)).toBe("");
  });
  it("renders the in→out pair, coercing null to 0", () => {
    expect(formatTokens(100, 50)).toBe("100→50");
    expect(formatTokens(10, null)).toBe("10→0");
    expect(formatTokens(null, 5)).toBe("0→5");
  });
});

describe("formatCost", () => {
  it("returns null for null / non-numeric", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost("abc")).toBeNull();
  });
  it("renders $0 for zero", () => {
    expect(formatCost("0")).toBe("$0");
  });
  it("uses 4 decimals for small figures, 2 for larger", () => {
    expect(formatCost("0.001200")).toBe("$0.0012");
    expect(formatCost("1.50")).toBe("$1.50");
  });
});

describe("formatTimestamp", () => {
  it("returns the raw value for an unparseable string", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
  it("formats a valid ISO timestamp to a locale string", () => {
    expect(formatTimestamp("2026-06-16T00:00:00.000Z")).not.toBe(
      "2026-06-16T00:00:00.000Z",
    );
  });
});

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());
  it("renders coarse buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00.000Z"));
    expect(timeAgo("2026-06-16T11:59:30.000Z")).toBe("30s ago");
    expect(timeAgo("2026-06-16T11:30:00.000Z")).toBe("30m ago");
    expect(timeAgo("2026-06-16T09:00:00.000Z")).toBe("3h ago");
    expect(timeAgo("2026-06-14T12:00:00.000Z")).toBe("2d ago");
  });
  it("returns empty string for an invalid date", () => {
    expect(timeAgo("nope")).toBe("");
  });
});

describe("statusBadgeVariant", () => {
  it("maps statuses to semantic variants", () => {
    expect(statusBadgeVariant("completed")).toBe("success");
    expect(statusBadgeVariant("running")).toBe("info");
    expect(statusBadgeVariant("planning")).toBe("info");
    expect(statusBadgeVariant("failed")).toBe("error");
    expect(statusBadgeVariant("cancelled")).toBe("warning");
    expect(statusBadgeVariant("pending")).toBe("muted");
    expect(statusBadgeVariant("weird")).toBe("muted");
  });
});
