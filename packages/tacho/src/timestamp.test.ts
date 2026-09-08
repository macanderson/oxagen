import { describe, expect, it } from "vitest";
import {
  fromUnixNano,
  isProtocolTimestamp,
  toProtocolTimestamp,
} from "./timestamp";

describe("protocol timestamps", () => {
  it("accepts the uppercase T, uppercase Z, UTC profile with optional fractions", () => {
    expect(isProtocolTimestamp("2026-09-08T10:06:03Z")).toBe(true);
    expect(isProtocolTimestamp("2026-09-08T10:06:03.123Z")).toBe(true);
    expect(isProtocolTimestamp("2026-09-08T10:06:03.123456789Z")).toBe(true);
  });

  it("rejects lowercase markers, offsets, spaces, and impossible dates", () => {
    expect(isProtocolTimestamp("2026-09-08t10:06:03z")).toBe(false);
    expect(isProtocolTimestamp("2026-09-08T10:06:03+00:00")).toBe(false);
    expect(isProtocolTimestamp("2026-09-08 10:06:03Z")).toBe(false);
    expect(isProtocolTimestamp("2026-13-08T10:06:03Z")).toBe(false);
    expect(isProtocolTimestamp("2026-02-30T10:06:03Z")).toBe(false);
  });

  it("renders dates and OTLP nanoseconds in the profile", () => {
    expect(toProtocolTimestamp(new Date(1_788_861_963_448))).toBe(
      "2026-09-08T10:06:03.448Z",
    );
    expect(fromUnixNano("1788861963448308000")).toBe(
      "2026-09-08T10:06:03.448Z",
    );
    expect(fromUnixNano(1_788_861_963_448_308_000)).toBe(
      "2026-09-08T10:06:03.448Z",
    );
    expect(() => toProtocolTimestamp(new Date(Number.NaN))).toThrow(TypeError);
  });
});
