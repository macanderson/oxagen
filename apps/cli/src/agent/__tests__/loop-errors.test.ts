/**
 * normalizeAgentError turns raw AI Gateway / stream errors into one clean,
 * actionable line — so dogfooding failures (no credits, bad key, rate limit)
 * are legible instead of dumping the SDK's internal error object.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeAgentError, isErrorResult, stringifyCapped } from "../loop.js";

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

describe("isErrorResult — sets the ok flag on tool events", () => {
  it("flags an Error instance", () => {
    expect(isErrorResult(new Error("boom"))).toBe(true);
  });
  it("flags an object with isError:true or a truthy error", () => {
    expect(isErrorResult({ isError: true })).toBe(true);
    expect(isErrorResult({ error: "ENOENT" })).toBe(true);
  });
  it("treats a normal result (incl. error:false / error:null) as ok", () => {
    expect(isErrorResult({ ok: true, output: "done" })).toBe(false);
    expect(isErrorResult({ error: false })).toBe(false);
    expect(isErrorResult({ error: null })).toBe(false);
    expect(isErrorResult("plain string output")).toBe(false);
    expect(isErrorResult(undefined)).toBe(false);
  });
});

describe("stringifyCapped — bounds captured tool input/results", () => {
  it("passes a short string through and JSON-stringifies objects", () => {
    expect(stringifyCapped("hi", 100)).toBe("hi");
    expect(stringifyCapped({ path: "src/x.ts" }, 100)).toBe('{"path":"src/x.ts"}');
  });
  it("truncates with an ellipsis past the cap", () => {
    const out = stringifyCapped("x".repeat(50), 10);
    expect(out).toBe("x".repeat(10) + "…");
  });
  it("falls back to String() for unserializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof stringifyCapped(circular, 100)).toBe("string");
  });
});

describe("stringifyCapped — OXAGEN_DEBUG breadcrumb on fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["OXAGEN_DEBUG"];
  });

  /** A value JSON.stringify throws on, forcing the String() fallback path. */
  function circular(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    c.self = c;
    return c;
  }

  it("writes a breadcrumb to stderr when OXAGEN_DEBUG is set", () => {
    process.env["OXAGEN_DEBUG"] = "1";
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stringifyCapped(circular(), 100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("[loop] stringifyCapped");
  });

  it("stays silent when OXAGEN_DEBUG is unset", () => {
    delete process.env["OXAGEN_DEBUG"];
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stringifyCapped(circular(), 100);
    expect(spy).not.toHaveBeenCalled();
  });
});
