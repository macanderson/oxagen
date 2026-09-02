// conditions.test.ts — unit tests for the IAM condition evaluator.
// Covers: empty/null, time_window (in/out/midnight-wrap/weekday/tz),
// ip_ranges (IPv4/IPv6/CIDR/null-IP), unknown keys, malformed input.

import { describe, expect, it } from "vitest";
import { evaluateConditions } from "./conditions";
import type { ConditionEvalContext } from "./conditions";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a context with a fixed UTC time (hour:min, weekday is inferred from date). */
function ctx(
  overrides: Partial<ConditionEvalContext> & { nowIso?: string },
): ConditionEvalContext {
  const now = overrides.nowIso
    ? new Date(overrides.nowIso)
    : (overrides.now ?? new Date());
  return {
    now,
    clientIp: overrides.clientIp ?? null,
  };
}

// ── Empty / null / malformed conditions ──────────────────────────────────────

describe("evaluateConditions — empty/null/malformed", () => {
  it("null conditions → true (unconditional grant)", () => {
    expect(evaluateConditions(null, ctx({}))).toBe(true);
  });

  it("undefined conditions → true", () => {
    expect(evaluateConditions(undefined, ctx({}))).toBe(true);
  });

  it("empty object → true", () => {
    expect(evaluateConditions({}, ctx({}))).toBe(true);
  });

  it("array → false (malformed, fail-closed)", () => {
    expect(evaluateConditions([], ctx({}))).toBe(false);
  });

  it("string → false (malformed, fail-closed)", () => {
    expect(evaluateConditions("allow", ctx({}))).toBe(false);
  });

  it("number → false (malformed, fail-closed)", () => {
    expect(evaluateConditions(42, ctx({}))).toBe(false);
  });

  it("unknown key → false (fail-closed)", () => {
    expect(evaluateConditions({ unknown_condition: true }, ctx({}))).toBe(
      false,
    );
  });

  it("mix of known and unknown keys → false (fail-closed)", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"], mystery_field: "yes" },
        ctx({ clientIp: "10.1.2.3" }),
      ),
    ).toBe(false);
  });
});

// ── time_window ───────────────────────────────────────────────────────────────

describe("evaluateConditions — time_window", () => {
  // 2025-01-06 is a Monday (weekday 1). UTC 14:00.
  const MON_14_UTC = "2025-01-06T14:00:00Z";
  // 2025-01-11 is a Saturday (weekday 6). UTC 14:00.
  const SAT_14_UTC = "2025-01-11T14:00:00Z";
  // 2025-01-06T23:30Z — Monday night, wraps to next day in some timezones.
  const MON_2330_UTC = "2025-01-06T23:30:00Z";
  // 2025-01-07T02:00Z — Tuesday early morning UTC.
  const TUE_0200_UTC = "2025-01-07T02:00:00Z";

  it("in window (UTC) → true", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "13:00", end: "15:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(true);
  });

  it("before window start → false", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "15:00", end: "17:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("after window end → false", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "09:00", end: "12:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("exactly at start time → true (inclusive)", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "14:00", end: "15:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(true);
  });

  it("exactly at end time → false (exclusive)", () => {
    // 15:00 UTC
    expect(
      evaluateConditions(
        { time_window: { start: "13:00", end: "15:00" } },
        ctx({ nowIso: "2025-01-06T15:00:00Z" }),
      ),
    ).toBe(false);
  });

  it("midnight-wrap window: 22:00–06:00, now=23:30 → true", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "22:00", end: "06:00" } },
        ctx({ nowIso: MON_2330_UTC }),
      ),
    ).toBe(true);
  });

  it("midnight-wrap window: 22:00–06:00, now=02:00 → true", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "22:00", end: "06:00" } },
        ctx({ nowIso: TUE_0200_UTC }),
      ),
    ).toBe(true);
  });

  it("midnight-wrap window: 22:00–06:00, now=14:00 → false", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "22:00", end: "06:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("zero-length window (start===end) → false", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "14:00", end: "14:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("weekday filter: Mon in [1,2,3,4,5] → true", () => {
    expect(
      evaluateConditions(
        {
          time_window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
        },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(true);
  });

  it("weekday filter: Sat not in [1,2,3,4,5] → false", () => {
    expect(
      evaluateConditions(
        {
          time_window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
        },
        ctx({ nowIso: SAT_14_UTC }),
      ),
    ).toBe(false);
  });

  it("weekday filter: all days [0,1,2,3,4,5,6] → true for any day", () => {
    expect(
      evaluateConditions(
        {
          time_window: {
            days: [0, 1, 2, 3, 4, 5, 6],
            start: "09:00",
            end: "18:00",
          },
        },
        ctx({ nowIso: SAT_14_UTC }),
      ),
    ).toBe(true);
  });

  it("timezone: UTC+5:30 shifts time so a UTC-14:00 request is in a different local hour", () => {
    // 2025-01-06T14:00Z = 19:30 IST (UTC+5:30)
    // Window 19:00–20:00 IST → should be in window.
    expect(
      evaluateConditions(
        { time_window: { tz: "Asia/Kolkata", start: "19:00", end: "20:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(true);
  });

  it("timezone: UTC-5 shifts time so the same UTC time is outside window", () => {
    // 2025-01-06T14:00Z = 09:00 EST (UTC-5)
    // Window 13:00–17:00 EST → 09:00 is before window → false
    expect(
      evaluateConditions(
        {
          time_window: { tz: "America/New_York", start: "13:00", end: "17:00" },
        },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("timezone: UTC-5 within window", () => {
    // 2025-01-06T19:00Z = 14:00 EST → inside 13:00–17:00
    expect(
      evaluateConditions(
        {
          time_window: { tz: "America/New_York", start: "13:00", end: "17:00" },
        },
        ctx({ nowIso: "2025-01-06T19:00:00Z" }),
      ),
    ).toBe(true);
  });

  it("malformed time_window (not an object) → false", () => {
    expect(
      evaluateConditions(
        { time_window: "09:00-17:00" },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("malformed start time → false", () => {
    expect(
      evaluateConditions(
        { time_window: { start: "25:00", end: "17:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("malformed days array (out-of-range value) → false", () => {
    expect(
      evaluateConditions(
        { time_window: { days: [1, 8], start: "09:00", end: "18:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });

  it("malformed days (not an array) → false", () => {
    expect(
      evaluateConditions(
        { time_window: { days: "1,2,3", start: "09:00", end: "18:00" } },
        ctx({ nowIso: MON_14_UTC }),
      ),
    ).toBe(false);
  });
});

// ── ip_ranges ─────────────────────────────────────────────────────────────────

describe("evaluateConditions — ip_ranges", () => {
  it("IPv4 in /8 CIDR → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"] },
        ctx({ clientIp: "10.1.2.3" }),
      ),
    ).toBe(true);
  });

  it("IPv4 outside /8 CIDR → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"] },
        ctx({ clientIp: "11.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("IPv4 exact match /32 → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["192.168.1.100/32"] },
        ctx({ clientIp: "192.168.1.100" }),
      ),
    ).toBe(true);
  });

  it("IPv4 /32 exact mismatch → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["192.168.1.100/32"] },
        ctx({ clientIp: "192.168.1.101" }),
      ),
    ).toBe(false);
  });

  it("IPv4 in /24 subnet → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["192.168.1.0/24"] },
        ctx({ clientIp: "192.168.1.255" }),
      ),
    ).toBe(true);
  });

  it("IPv4 outside /24 subnet → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["192.168.1.0/24"] },
        ctx({ clientIp: "192.168.2.1" }),
      ),
    ).toBe(false);
  });

  it("IPv4 in /0 (all IPs) → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["0.0.0.0/0"] },
        ctx({ clientIp: "1.2.3.4" }),
      ),
    ).toBe(true);
  });

  it("null clientIp → false (fail-closed for any IP condition)", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"] },
        ctx({ clientIp: null }),
      ),
    ).toBe(false);
  });

  it("multiple CIDRs: IP matches second → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8", "172.16.0.0/12"] },
        ctx({ clientIp: "172.16.5.1" }),
      ),
    ).toBe(true);
  });

  it("multiple CIDRs: IP matches none → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8", "172.16.0.0/12"] },
        ctx({ clientIp: "192.168.0.1" }),
      ),
    ).toBe(false);
  });

  it("IPv6 in /32 CIDR → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["2001:db8::/32"] },
        ctx({ clientIp: "2001:db8::1" }),
      ),
    ).toBe(true);
  });

  it("IPv6 outside /32 CIDR → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["2001:db8::/32"] },
        ctx({ clientIp: "2001:db9::1" }),
      ),
    ).toBe(false);
  });

  it("IPv6 loopback in /128 → true", () => {
    expect(
      evaluateConditions({ ip_ranges: ["::1/128"] }, ctx({ clientIp: "::1" })),
    ).toBe(true);
  });

  it("IPv6 loopback /128 mismatch → false", () => {
    expect(
      evaluateConditions({ ip_ranges: ["::1/128"] }, ctx({ clientIp: "::2" })),
    ).toBe(false);
  });

  it("IPv4-mapped IPv6 (::ffff:10.0.0.1) matched against IPv4 CIDR 10.0.0.0/8 → true", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"] },
        ctx({ clientIp: "::ffff:10.0.0.1" }),
      ),
    ).toBe(true);
  });

  it("IPv4-mapped IPv6 outside IPv4 CIDR → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: ["10.0.0.0/8"] },
        ctx({ clientIp: "::ffff:11.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("ip_allow alias works identically to ip_ranges", () => {
    expect(
      evaluateConditions(
        { ip_allow: ["10.0.0.0/8"] },
        ctx({ clientIp: "10.1.2.3" }),
      ),
    ).toBe(true);
  });

  it("malformed ip_ranges (not an array) → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: "10.0.0.0/8" },
        ctx({ clientIp: "10.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("malformed ip_ranges (array contains non-string) → false", () => {
    expect(
      evaluateConditions(
        { ip_ranges: [10, "10.0.0.0/8"] },
        ctx({ clientIp: "10.0.0.1" }),
      ),
    ).toBe(false);
  });
});

// ── AND combination ───────────────────────────────────────────────────────────

describe("evaluateConditions — AND combination", () => {
  const IN_WINDOW_UTC = "2025-01-06T14:00:00Z"; // Monday 14:00 UTC

  it("time_window AND ip_ranges — both pass → true", () => {
    expect(
      evaluateConditions(
        {
          time_window: { start: "13:00", end: "15:00" },
          ip_ranges: ["10.0.0.0/8"],
        },
        ctx({ nowIso: IN_WINDOW_UTC, clientIp: "10.1.2.3" }),
      ),
    ).toBe(true);
  });

  it("time_window AND ip_ranges — time fails → false", () => {
    expect(
      evaluateConditions(
        {
          time_window: { start: "09:00", end: "12:00" },
          ip_ranges: ["10.0.0.0/8"],
        },
        ctx({ nowIso: IN_WINDOW_UTC, clientIp: "10.1.2.3" }),
      ),
    ).toBe(false);
  });

  it("time_window AND ip_ranges — IP fails → false", () => {
    expect(
      evaluateConditions(
        {
          time_window: { start: "13:00", end: "15:00" },
          ip_ranges: ["192.168.0.0/16"],
        },
        ctx({ nowIso: IN_WINDOW_UTC, clientIp: "10.1.2.3" }),
      ),
    ).toBe(false);
  });

  it("time_window AND ip_ranges — both fail → false", () => {
    expect(
      evaluateConditions(
        {
          time_window: { start: "09:00", end: "12:00" },
          ip_ranges: ["192.168.0.0/16"],
        },
        ctx({ nowIso: IN_WINDOW_UTC, clientIp: "10.1.2.3" }),
      ),
    ).toBe(false);
  });
});
