import { describe, it, expect } from "vitest";
import { safeHref, isSafeHref } from "./safe-url";

const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

describe("safeHref", () => {
  it("passes http(s) absolute URLs (returning the trimmed value)", () => {
    expect(safeHref("https://example.com/a?b=1#c")).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("passes same-document relative references", () => {
    expect(safeHref("/org/ws/page")).toBe("/org/ws/page");
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("?q=hello")).toBe("?q=hello");
  });

  it("rejects javascript: scheme", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeUndefined();
  });

  it("rejects scheme obfuscated with embedded control characters", () => {
    // Browsers collapse `java\tscript:` → `javascript:` when navigating.
    expect(safeHref(`java${TAB}script:alert(1)`)).toBeUndefined();
    expect(safeHref(`java${NEWLINE}script:alert(1)`)).toBeUndefined();
    expect(safeHref(`${NUL}javascript:alert(1)`)).toBeUndefined();
    expect(safeHref(`  java${TAB}script:alert(1)  `)).toBeUndefined();
  });

  it("rejects data:, vbscript:, blob:, file: schemes", () => {
    expect(
      safeHref("data:text/html,<script>alert(1)</script>"),
    ).toBeUndefined();
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeHref("blob:https://example.com/uuid")).toBeUndefined();
    expect(safeHref("file:///etc/passwd")).toBeUndefined();
  });

  it("rejects protocol-relative URLs (external origin)", () => {
    expect(safeHref("//evil.com/path")).toBeUndefined();
  });

  it("rejects backslash spellings of a protocol-relative URL", () => {
    // Browsers treat `\` exactly like `/` when deciding whether a reference is
    // scheme-relative, so each of these navigates to evil.com.
    expect(safeHref("/\\evil.com/path")).toBeUndefined();
    expect(safeHref("\\\\evil.com/path")).toBeUndefined();
    expect(safeHref("\\/evil.com/path")).toBeUndefined();
  });

  it("rejects null, undefined, empty, and whitespace-only", () => {
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
    expect(safeHref("   ")).toBeUndefined();
  });

  it("rejects unparseable / bare non-scheme strings", () => {
    expect(safeHref("not a url")).toBeUndefined();
    expect(safeHref("mailto:foo@bar.com")).toBeUndefined();
  });
});

describe("isSafeHref", () => {
  it("mirrors safeHref as a boolean", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("/relative")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref(null)).toBe(false);
  });
});
