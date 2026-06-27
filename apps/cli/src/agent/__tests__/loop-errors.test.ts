/**
 * normalizeAgentError turns raw AI Gateway / stream errors into one clean,
 * actionable line — so dogfooding failures (no credits, bad key, rate limit)
 * are legible instead of dumping the SDK's internal error object.
 */
import { describe, it, expect } from "vitest";
import { normalizeAgentError } from "../loop.js";

/** Shape of an AI SDK gateway error: provider JSON lives on `responseBody`. */
function gatewayError(message: string, type = "error"): Error {
  const err = new Error("No output generated. Check the stream for errors.");
  (err as unknown as { responseBody: string }).responseBody = JSON.stringify({
    error: { message, type },
  });
  return err;
}

describe("normalizeAgentError", () => {
  it("translates insufficient-funds into an add-credits message", () => {
    const out = normalizeAgentError(
      gatewayError(
        "A positive credit balance is required for all requests, including BYOK.",
        "insufficient_funds",
      ),
    );
    expect(out.message).toContain("no credit balance");
    expect(out.message).toContain("Vercel AI Gateway");
    // The opaque SDK wrapper message must not leak through.
    expect(out.message).not.toContain("No output generated");
  });

  it("translates a 401 into a key-check message", () => {
    const out = normalizeAgentError(gatewayError("401 Unauthorized: invalid api key"));
    expect(out.message).toContain("401");
    expect(out.message).toContain("AI_GATEWAY_API_KEY");
  });

  it("translates a 429 into a rate-limit message", () => {
    const out = normalizeAgentError(gatewayError("429 rate limit exceeded"));
    expect(out.message).toContain("429");
    expect(out.message.toLowerCase()).toContain("rate");
  });

  it("passes through an ordinary Error unchanged", () => {
    const original = new Error("something specific broke");
    expect(normalizeAgentError(original)).toBe(original);
  });

  it("wraps a non-Error value into an Error", () => {
    const out = normalizeAgentError("plain string failure");
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain("plain string failure");
  });
});
