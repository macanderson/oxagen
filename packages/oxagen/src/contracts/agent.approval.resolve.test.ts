import { describe, expect, it } from "vitest";
import { agentApprovalResolve } from "./agent.approval.resolve";
import { getCapability } from "../registry";

describe("agent.approval.resolve capability", () => {
  it("parses a valid approved decision", () => {
    const parsed = agentApprovalResolve.input.parse({
      approvalId: "appr_1",
      decision: "approved",
    });
    expect(parsed.decision).toBe("approved");
  });

  it("parses a valid denied decision with a note", () => {
    const parsed = agentApprovalResolve.input.parse({
      approvalId: "appr_1",
      decision: "denied",
      note: "Out of scope",
    });
    expect(parsed.note).toBe("Out of scope");
  });

  it("rejects an unknown decision", () => {
    expect(() =>
      agentApprovalResolve.input.parse({
        approvalId: "appr_1",
        decision: "maybe",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentApprovalResolve.output.parse({
      approvalId: "appr_1",
      resolution: "approved",
    });
    expect(parsed.resolution).toBe("approved");
  });

  it("rejects an unknown resolution", () => {
    expect(() =>
      agentApprovalResolve.output.parse({
        approvalId: "appr_1",
        resolution: "stalled",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.approval.resolve")).toBe(agentApprovalResolve);
  });
});
