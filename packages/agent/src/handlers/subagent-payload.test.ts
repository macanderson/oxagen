import { describe, expect, it } from "vitest";
import {
  RUN_SUMMARY_MAX_CHARS,
  capPayload,
  fallbackRunSummary,
  payloadByteSize,
} from "./subagent-payload";

describe("payloadByteSize", () => {
  it("returns 0 for null/undefined", () => {
    expect(payloadByteSize(null)).toBe(0);
    expect(payloadByteSize(undefined)).toBe(0);
  });

  it("returns serialized byte length for objects", () => {
    expect(payloadByteSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
  });

  it("returns 0 for unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(payloadByteSize(cyclic)).toBe(0);
  });
});

describe("fallbackRunSummary", () => {
  it("prefers a declared summary field, trimmed", () => {
    expect(fallbackRunSummary({ summary: "  done  ", rest: 1 }, null)).toBe(
      "done",
    );
  });

  it("falls back message → text in order", () => {
    expect(fallbackRunSummary({ message: "m" }, null)).toBe("m");
    expect(fallbackRunSummary({ text: "t" }, null)).toBe("t");
  });

  it("truncates JSON serialization to the summary budget", () => {
    const out = fallbackRunSummary({ blob: "x".repeat(1000) }, null);
    expect(out.length).toBe(RUN_SUMMARY_MAX_CHARS);
  });

  it("uses errorReason when there is no output", () => {
    expect(fallbackRunSummary(null, "exploded")).toBe("exploded");
  });

  it("returns empty string when nothing is available", () => {
    expect(fallbackRunSummary(null, null)).toBe("");
  });
});

describe("capPayload", () => {
  it("passes small payloads through untouched", () => {
    const v = { a: 1 };
    expect(capPayload(v, 1024)).toEqual({ value: v, truncated: false });
  });

  it("replaces oversized payloads with a truncated JSON string", () => {
    const { value, truncated } = capPayload({ blob: "x".repeat(5000) }, 1024);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeLessThanOrEqual(1025); // cap + ellipsis
  });

  it("handles unserializable payloads as truncated null", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(capPayload(cyclic, 1024)).toEqual({ value: null, truncated: true });
  });

  it("passes null through", () => {
    expect(capPayload(null, 8)).toEqual({ value: null, truncated: false });
  });
});
