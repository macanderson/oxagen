import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEXT,
  MAX_NEXT_LENGTH,
  firstParam,
  sanitizeNext,
  withNext,
} from "./safe-next";

describe("sanitizeNext", () => {
  it("keeps a valid same-origin path with its query and hash", () => {
    expect(sanitizeNext("/acme/core-platform")).toBe("/acme/core-platform");
    expect(sanitizeNext("/acme/core-platform/tools?tab=registry#top")).toBe(
      "/acme/core-platform/tools?tab=registry#top",
    );
  });

  it("keeps the CLI authorize round-trip, whose query carries a loopback URL", () => {
    const next =
      "/cli/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&state=s1";
    expect(sanitizeNext(next)).toBe(next);
  });

  it.each([
    ["protocol-relative host", "//evil.example"],
    ["protocol-relative host with path", "//evil.example/acme"],
    ["backslash host", "/\\evil"],
    ["backslash host with more slashes", "/\\/evil.example"],
    ["absolute URL", "https://evil"],
    ["absolute URL to this app", "http://localhost:3000/acme"],
    ["javascript: URL", "javascript:alert(1)"],
    ["relative path without a slash", "acme/core-platform"],
    ["tab smuggled between slashes", "/\t/evil.example"],
    ["newline smuggled between slashes", "/\n/evil.example"],
    ["backslash later in the path", "/acme\\..\\..\\evil"],
    ["dot segments that normalise to a host", "/a/../..//evil.example"],
    ["empty string", ""],
  ])("refuses %s", (_label, raw) => {
    expect(sanitizeNext(raw)).toBe(DEFAULT_NEXT);
  });

  it("refuses a destination back into the sign-in flow", () => {
    expect(sanitizeNext("/login")).toBe(DEFAULT_NEXT);
    expect(sanitizeNext("/two-factor?next=%2Facme")).toBe(DEFAULT_NEXT);
    expect(sanitizeNext("/loginx")).toBe("/loginx");
  });

  it("refuses non-strings and oversized values", () => {
    expect(sanitizeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(sanitizeNext(["/acme"])).toBe(DEFAULT_NEXT);
    expect(sanitizeNext(`/${"a".repeat(MAX_NEXT_LENGTH)}`)).toBe(DEFAULT_NEXT);
  });

  it("returns the caller's fallback when refusing", () => {
    expect(sanitizeNext("//evil.example", "/welcome")).toBe("/welcome");
  });
});

describe("firstParam", () => {
  it("takes the first of a repeated search param", () => {
    expect(firstParam(["/a", "/b"])).toBe("/a");
    expect(firstParam("/a")).toBe("/a");
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe("withNext", () => {
  it("carries a destination forward, encoded", () => {
    expect(withNext("/signup", "/acme/core-platform")).toBe(
      "/signup?next=%2Facme%2Fcore-platform",
    );
    expect(withNext("/verify?email=a%40b.c", "/acme")).toBe(
      "/verify?email=a%40b.c&next=%2Facme",
    );
  });

  it("leaves the link bare when the destination is the default", () => {
    expect(withNext("/signup", DEFAULT_NEXT)).toBe("/signup");
  });
});
