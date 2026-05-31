import { describe, expect, it } from "vitest";
import { deriveFanoutStatus } from "./agent.execute-subagent.js";

describe("deriveFanoutStatus", () => {
  it("returns 'completed' when all children succeed", () => {
    expect(deriveFanoutStatus(3, 3, false)).toBe("completed");
  });

  it("returns 'completed' for empty fanout (zero runs)", () => {
    // 0 === 0, no failures
    expect(deriveFanoutStatus(0, 0, false)).toBe("completed");
  });

  it("returns 'failed' when all children fail (regression: was 'completed' before fix)", () => {
    // completed=0, total=3, anyFailed=true → must be "failed", not "completed"
    expect(deriveFanoutStatus(0, 3, true)).toBe("failed");
  });

  it("returns 'partial' when some children succeed and some fail", () => {
    expect(deriveFanoutStatus(1, 3, true)).toBe("partial");
    expect(deriveFanoutStatus(2, 3, true)).toBe("partial");
  });

  it("returns 'completed' for single successful child", () => {
    expect(deriveFanoutStatus(1, 1, false)).toBe("completed");
  });

  it("returns 'failed' for single failed child (regression case)", () => {
    expect(deriveFanoutStatus(0, 1, true)).toBe("failed");
  });
});
