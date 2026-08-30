/**
 * stream-parts.test.ts — unit tests for the pure stream-part helpers.
 *
 * Focus: `formatStreamError`, which reduces an arbitrary thrown/streamed error
 * value into a clean {code, message} the chat UI can render as a toast. The
 * regression it guards against: a 402 billing envelope
 * (`{"error":{"code":"insufficient_credits","message":"…"},"requestId":"…"}`)
 * leaking onto the page as raw, unformatted JSON.
 */

import { describe, it, expect } from "vitest";
import {
  errorMessageOf,
  formatStreamError,
  isRecord,
  partType,
} from "./stream-parts";

const ENVELOPE = {
  error: {
    code: "insufficient_credits",
    message:
      "Insufficient credits: your balance is empty. Please add credits to continue.",
  },
  requestId: "27de4a9d-1b01-4249-a174-563ba651aee6",
};
const ENVELOPE_JSON = JSON.stringify(ENVELOPE);

describe("formatStreamError — envelope parsing", () => {
  it("extracts code + message from an Error whose .message IS the JSON envelope", () => {
    const result = formatStreamError(new Error(ENVELOPE_JSON));
    expect(result.code).toBe("insufficient_credits");
    expect(result.message).toBe(ENVELOPE.error.message);
    // The raw JSON braces must NOT survive into the human message.
    expect(result.message).not.toContain("{");
    expect(result.message).not.toContain("requestId");
  });

  it("extracts code + message from a raw envelope STRING", () => {
    const result = formatStreamError(ENVELOPE_JSON);
    expect(result).toEqual({
      code: "insufficient_credits",
      message: ENVELOPE.error.message,
    });
  });

  it("extracts code + message from an already-parsed envelope OBJECT", () => {
    const result = formatStreamError(ENVELOPE);
    expect(result).toEqual({
      code: "insufficient_credits",
      message: ENVELOPE.error.message,
    });
  });

  it("returns message without code when the envelope omits a code", () => {
    const result = formatStreamError(
      JSON.stringify({ error: { message: "Gateway exploded" } }),
    );
    expect(result.code).toBeUndefined();
    expect(result.message).toBe("Gateway exploded");
  });

  it("parses an envelope where `error` is itself a string", () => {
    const result = formatStreamError(JSON.stringify({ error: "Bad request" }));
    expect(result).toEqual({ message: "Bad request" });
  });

  it("parses a flat { message, code } shape", () => {
    const result = formatStreamError(
      JSON.stringify({ code: "rate_limited", message: "Slow down" }),
    );
    expect(result).toEqual({ code: "rate_limited", message: "Slow down" });
  });
});

describe("formatStreamError — non-envelope fallbacks", () => {
  it("passes through a plain prose string untouched", () => {
    const result = formatStreamError("Gateway timeout");
    expect(result).toEqual({ message: "Gateway timeout" });
  });

  it("passes through an Error with a prose (non-JSON) message", () => {
    const result = formatStreamError(new Error("Model not found"));
    expect(result).toEqual({ message: "Model not found" });
  });

  it("does not mis-parse a brace-containing prose string as JSON", () => {
    // Looks vaguely JSON-ish but is not valid JSON — must pass through as-is.
    const messy = "{not really json";
    const result = formatStreamError(messy);
    expect(result.message).toBe(messy);
    expect(result.code).toBeUndefined();
  });

  it("falls back to a generic message for null/undefined/number values", () => {
    expect(formatStreamError(null).message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(formatStreamError(undefined).message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(formatStreamError(42).message).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("falls back to a generic message for an empty/whitespace string", () => {
    expect(formatStreamError("   ").message).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("falls back to a generic message for an envelope with a blank message", () => {
    const result = formatStreamError(
      JSON.stringify({ error: { code: "x", message: "  " } }),
    );
    expect(result.message).toBe("Something went wrong. Please try again.");
  });

  it("always returns a non-empty message (invariant)", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "",
      "{}",
      "[]",
      0,
      false,
      {},
      { error: {} },
    ];
    for (const c of cases) {
      expect(formatStreamError(c).message.length).toBeGreaterThan(0);
    }
  });
});

// Guard the sibling helpers so this module's public surface stays covered.
describe("stream-parts misc helpers", () => {
  it("errorMessageOf normalizes Error / string / other", () => {
    expect(errorMessageOf(new Error("boom"))).toBe("boom");
    expect(errorMessageOf("plain")).toBe("plain");
    expect(errorMessageOf(123)).toBe("Tool execution failed");
  });

  it("isRecord distinguishes objects from primitives and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("partType reads a discriminant or returns undefined", () => {
    expect(partType({ type: "text-delta" })).toBe("text-delta");
    expect(partType(null)).toBeUndefined();
    expect(partType({})).toBeUndefined();
  });
});
