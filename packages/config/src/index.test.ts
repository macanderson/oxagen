// index.test.ts — unit tests for platformVersion() exported from index.ts.
//
// platformVersion() reads process.env.PLATFORM_VERSION, falls back to "0.0.0"
// when unset, and strips one surrounding double-quote pair via stripOneQuotePair.

import { describe, expect, it, afterEach } from "vitest";
import { platformVersion } from "./index";

const originalPlatformVersion = process.env.PLATFORM_VERSION;

afterEach(() => {
  // Restore original value after each test.
  if (originalPlatformVersion === undefined) {
    delete process.env.PLATFORM_VERSION;
  } else {
    process.env.PLATFORM_VERSION = originalPlatformVersion;
  }
});

describe("platformVersion", () => {
  it("returns '0.0.0' when PLATFORM_VERSION is unset", () => {
    delete process.env.PLATFORM_VERSION;
    expect(platformVersion()).toBe("0.0.0");
  });

  it("returns the value as-is when not double-quoted", () => {
    process.env.PLATFORM_VERSION = "1.2.3";
    expect(platformVersion()).toBe("1.2.3");
  });

  it("strips one surrounding double-quote pair (Vercel dashboard paste behaviour)", () => {
    process.env.PLATFORM_VERSION = '"1.2.3"';
    expect(platformVersion()).toBe("1.2.3");
  });

  it("does not double-strip triply-quoted values (only one pair removed)", () => {
    process.env.PLATFORM_VERSION = '""1.2.3""';
    expect(platformVersion()).toBe('"1.2.3"');
  });

  it("does not strip mismatched quotes", () => {
    process.env.PLATFORM_VERSION = '"1.2.3';
    expect(platformVersion()).toBe('"1.2.3');
  });
});
