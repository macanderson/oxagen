/**
 * pr-monitor tests — the pure check-summarization core (no GitHub calls).
 */
import { describe, it, expect } from "vitest";
import {
  summarizeChecks,
  isTerminal,
  formatSummary,
  type CheckRollupItem,
} from "../pr-monitor.js";

describe("summarizeChecks", () => {
  it("is green when every check passed", () => {
    const items: CheckRollupItem[] = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "e2e", conclusion: "SUCCESS" },
      { context: "atlas", state: "SUCCESS" },
    ];
    const s = summarizeChecks(items);
    expect(s.state).toBe("green");
    expect(s.passed).toBe(3);
    expect(s.failing).toEqual([]);
  });

  it("is failing when any check failed, and lists exactly the failures", () => {
    const items: CheckRollupItem[] = [
      { name: "test", conclusion: "SUCCESS" },
      {
        name: "checks",
        conclusion: "FAILURE",
        detailsUrl: "https://ci/checks",
      },
      { name: "lint", conclusion: "TIMED_OUT" },
      { name: "e2e", conclusion: null, state: null }, // pending — doesn't hide the failure
    ];
    const s = summarizeChecks(items);
    expect(s.state).toBe("failing");
    expect(s.failed).toBe(2);
    expect(s.failing.map((f) => f.name).sort()).toEqual(["checks", "lint"]);
    expect(s.failing.find((f) => f.name === "checks")?.url).toBe(
      "https://ci/checks",
    );
  });

  it("is pending when nothing failed but some are still running", () => {
    const items: CheckRollupItem[] = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "build", conclusion: null, state: "PENDING" },
      { name: "e2e", conclusion: null },
    ];
    const s = summarizeChecks(items);
    expect(s.state).toBe("pending");
    expect(s.pending).toBe(2);
  });

  it("treats CANCELLED/SKIPPED/NEUTRAL as non-failing (superseded runs don't wedge green)", () => {
    const items: CheckRollupItem[] = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "old-run", conclusion: "CANCELLED" },
      { name: "optional", conclusion: "SKIPPED" },
      { name: "advisory", conclusion: "NEUTRAL" },
    ];
    const s = summarizeChecks(items);
    expect(s.state).toBe("green");
    expect(s.failed).toBe(0);
  });

  it("is 'none' when a PR has no checks at all", () => {
    const s = summarizeChecks([]);
    expect(s.state).toBe("none");
    expect(s.total).toBe(0);
  });
});

describe("isTerminal", () => {
  it("is terminal for green/failing/none, not for pending", () => {
    expect(isTerminal(summarizeChecks([{ conclusion: "SUCCESS" }]))).toBe(true);
    expect(isTerminal(summarizeChecks([{ conclusion: "FAILURE" }]))).toBe(true);
    expect(isTerminal(summarizeChecks([]))).toBe(true);
    expect(isTerminal(summarizeChecks([{ state: "PENDING" }]))).toBe(false);
  });
});

describe("formatSummary", () => {
  it("names the failing checks in the failing summary", () => {
    const s = summarizeChecks([
      { name: "ok", conclusion: "SUCCESS" },
      { name: "checks", conclusion: "FAILURE" },
    ]);
    expect(formatSummary(s)).toContain("checks");
    expect(formatSummary(s)).toContain("✗");
  });
});
