/**
 * `formatFatalError` — proves the top-level error formatter shows only the
 * message by default and the full stack only under debug, for both Error and
 * non-Error throwables.
 */
import { describe, it, expect } from "vitest";
import { formatFatalError } from "../fatal-error.js";

describe("formatFatalError", () => {
  it("renders an Error as a single message line (no stack) by default", () => {
    const out = formatFatalError(new Error("boom"), false);
    expect(out).toBe("Error: boom\n");
    expect(out).not.toContain("at "); // no stack frames leaked
  });

  it("includes the full stack when debug is enabled", () => {
    const out = formatFatalError(new Error("kaboom"), true);
    expect(out).toContain("kaboom");
    expect(out).toContain("at "); // stack frames present
    expect(out.endsWith("\n")).toBe(true);
  });

  it("renders a non-Error value with the Error: prefix", () => {
    expect(formatFatalError("plain string failure", false)).toBe(
      "Error: plain string failure\n",
    );
  });

  it("stringifies a non-Error object rather than throwing", () => {
    expect(formatFatalError({ code: 42 }, true)).toBe(
      "Error: [object Object]\n",
    );
  });

  it("falls back to the message when a debug Error carries no stack", () => {
    const err = new Error("nostack");
    err.stack = undefined;
    expect(formatFatalError(err, true)).toBe("Error: nostack\n");
  });
});
