import { afterEach, describe, expect, it, vi } from "vitest";
import { surfaceReport } from "../surface.js";

describe("surfaceReport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes a succeeded report to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    surfaceReport({ targetId: "run-1", status: "succeeded" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("target=run-1");
    expect(out).toContain("succeeded");
  });

  it("spells out the fix assessment on a failure that is identified and fixable", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    surfaceReport({
      targetId: "run-2",
      status: "failed",
      identifiedProblem: true,
      canFixWithCommittedChanges: true,
      note: "lint failed on an import already removed in abc123",
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Identified the problem.");
    expect(out).toContain("should fix it");
    expect(out).toContain("abc123");
  });

  it("states when the problem was not identified and the commits do not fix it", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    surfaceReport({
      targetId: "run-3",
      status: "failed",
      identifiedProblem: false,
      canFixWithCommittedChanges: false,
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Could not identify the problem.");
    expect(out).toContain("do not appear to fix it");
  });
});
