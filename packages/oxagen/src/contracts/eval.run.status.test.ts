import { describe, expect, it } from "vitest";
import { evalRunStatus } from "./eval.run.status";
import { getCapability } from "../registry";

describe("eval.run.status capability", () => {
  it("parses a valid input", () => {
    const parsed = evalRunStatus.input.parse({ runPublicId: "run_pub_1" });
    expect(parsed.runPublicId).toBe("run_pub_1");
  });

  it("rejects an empty runPublicId", () => {
    expect(() => evalRunStatus.input.parse({ runPublicId: "" })).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalRunStatus.output.parse({
      runId: "run_1",
      status: "running",
      itemCount: 10,
      completedCount: 4,
      failedCount: 0,
      avgScore: 0.82,
      failureReason: null,
    });
    expect(out.status).toBe("running");
    expect(out.avgScore).toBe(0.82);
  });

  it("rejects an output with an invalid status enum value", () => {
    expect(() =>
      evalRunStatus.output.parse({
        runId: "run_1",
        status: "in_progress",
        itemCount: 10,
        completedCount: 4,
        failedCount: 0,
        avgScore: null,
        failureReason: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("eval.run.status")).toBe(evalRunStatus);
  });
});
