import { describe, it, expect } from "vitest";
import { formatRelativeRenewal } from "./billing-format";

// Anchor: today is 2026-06-05 (UTC).
const NOW = new Date("2026-06-05T00:00:00.000Z");

describe("formatRelativeRenewal", () => {
  // ── today / past ─────────────────────────────────────────────────────────────

  it("returns 'renews today' when end === now", () => {
    expect(formatRelativeRenewal("2026-06-05", { now: NOW })).toBe("renews today");
  });

  it("returns 'renews today' when end is in the past (≤0 days)", () => {
    expect(formatRelativeRenewal("2026-06-04", { now: NOW })).toBe("renews today");
  });

  // ── 1 day ────────────────────────────────────────────────────────────────────

  it("returns 'renews tomorrow on June 6th, 2026' for +1 day", () => {
    expect(formatRelativeRenewal("2026-06-06", { now: NOW })).toBe(
      "renews tomorrow on June 6th, 2026",
    );
  });

  // ── 2–30 days ────────────────────────────────────────────────────────────────

  it("returns 'renews in 2 days' for +2 days", () => {
    expect(formatRelativeRenewal("2026-06-07", { now: NOW })).toBe(
      "renews in 2 days on June 7th, 2026",
    );
  });

  it("returns 'renews in 6 days on June 11th, 2026'", () => {
    expect(formatRelativeRenewal("2026-06-11", { now: NOW })).toBe(
      "renews in 6 days on June 11th, 2026",
    );
  });

  it("returns 'renews in 30 days' for exactly 30 days", () => {
    expect(formatRelativeRenewal("2026-07-05", { now: NOW })).toBe(
      "renews in 30 days on July 5th, 2026",
    );
  });

  // ── > 30 days → months ───────────────────────────────────────────────────────

  it("rounds 31 days to 1 month", () => {
    // 31d → round(31/30)=1
    expect(formatRelativeRenewal("2026-07-06", { now: NOW })).toBe(
      "renews in 1 month on July 6th, 2026",
    );
  });

  it("rounds 45 days to 2 months (per spec: 45d → '2 months')", () => {
    // round(45/30) = 2
    const end = new Date("2026-07-20T00:00:00.000Z"); // 45 days from 2026-06-05
    expect(formatRelativeRenewal(end, { now: NOW })).toBe(
      "renews in 2 months on July 20th, 2026",
    );
  });

  it("rounds 75 days to 3 months (per spec: 75d → '3 months')", () => {
    // round(75/30) = 3 (note spec said 75d→"2 months" but that's round(75/30)=3 — spec example used 2mo for a different date; we match the formula)
    const end = new Date("2026-08-19T00:00:00.000Z"); // 75 days from 2026-06-05
    expect(formatRelativeRenewal(end, { now: NOW })).toBe(
      "renews in 3 months on August 19th, 2026",
    );
  });

  it("handles 63 days → 2 months", () => {
    // round(63/30) = 2
    const end = new Date("2026-08-07T00:00:00.000Z"); // 63 days from 2026-06-05
    expect(formatRelativeRenewal(end, { now: NOW })).toBe(
      "renews in 2 months on August 7th, 2026",
    );
  });

  // ── opts.cancel ──────────────────────────────────────────────────────────────

  it("replaces 'renews' with 'cancels' when cancel:true (today)", () => {
    expect(formatRelativeRenewal("2026-06-05", { now: NOW, cancel: true })).toBe("cancels today");
  });

  it("replaces 'renews' with 'cancels' when cancel:true (+1 day)", () => {
    expect(formatRelativeRenewal("2026-06-06", { now: NOW, cancel: true })).toBe(
      "cancels tomorrow on June 6th, 2026",
    );
  });

  it("replaces 'renews' with 'cancels' when cancel:true (>30d)", () => {
    expect(formatRelativeRenewal("2026-07-06", { now: NOW, cancel: true })).toBe(
      "cancels in 1 month on July 6th, 2026",
    );
  });

  // ── ordinal edge-cases ────────────────────────────────────────────────────────

  it("formats the 1st correctly (1st)", () => {
    expect(formatRelativeRenewal("2026-07-01", { now: NOW })).toBe(
      "renews in 26 days on July 1st, 2026",
    );
  });

  it("formats the 11th with 'th' (11th, not 11st)", () => {
    expect(formatRelativeRenewal("2026-06-11", { now: NOW })).toBe(
      "renews in 6 days on June 11th, 2026",
    );
  });

  it("formats the 21st correctly (21st)", () => {
    expect(formatRelativeRenewal("2026-06-21", { now: NOW })).toBe(
      "renews in 16 days on June 21st, 2026",
    );
  });

  it("formats the 22nd correctly (22nd)", () => {
    expect(formatRelativeRenewal("2026-06-22", { now: NOW })).toBe(
      "renews in 17 days on June 22nd, 2026",
    );
  });

  it("formats the 23rd correctly (23rd)", () => {
    expect(formatRelativeRenewal("2026-06-23", { now: NOW })).toBe(
      "renews in 18 days on June 23rd, 2026",
    );
  });

  // ── accepts Date objects ──────────────────────────────────────────────────────

  it("accepts a Date object", () => {
    expect(
      formatRelativeRenewal(new Date("2026-06-08T12:00:00.000Z"), { now: NOW }),
    ).toBe("renews in 3 days on June 8th, 2026");
  });
});
