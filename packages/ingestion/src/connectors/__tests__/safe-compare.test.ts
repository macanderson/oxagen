import { describe, it, expect } from "vitest";
import { constantTimeStringEqual } from "../safe-compare";

// Shared constant-time comparison used by the Zoom and Microsoft connectors'
// verifyWebhook. A naive `===` on the security boundary leaks the secret via
// response-time analysis; timingSafeEqual closes that, but throws on
// unequal-length buffers, which must fail closed (false) rather than throw.
describe("constantTimeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeStringEqual("my-secret-token", "my-secret-token")).toBe(
      true,
    );
  });

  it("returns false for different strings of the same length", () => {
    expect(
      constantTimeStringEqual("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"),
    ).toBe(false);
  });

  it("returns false — not throws — when lengths differ (shorter attacker guess)", () => {
    expect(() =>
      constantTimeStringEqual("short", "a-much-longer-secret-value"),
    ).not.toThrow();
    expect(constantTimeStringEqual("short", "a-much-longer-secret-value")).toBe(
      false,
    );
  });

  it("returns false — not throws — when lengths differ (longer attacker guess)", () => {
    expect(() =>
      constantTimeStringEqual("a-much-longer-guess-value", "short"),
    ).not.toThrow();
    expect(constantTimeStringEqual("a-much-longer-guess-value", "short")).toBe(
      false,
    );
  });

  it("returns false for empty vs non-empty", () => {
    expect(constantTimeStringEqual("", "non-empty")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeStringEqual("", "")).toBe(true);
  });
});
