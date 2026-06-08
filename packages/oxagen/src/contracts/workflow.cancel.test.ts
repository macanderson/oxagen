import { describe, expect, it } from "vitest";
import { workflowCancel } from "./workflow.cancel";
import { getCapability } from "../registry";

describe("workflow.cancel capability", () => {
  it("parses valid input with public ID", () => {
    const parsed = workflowCancel.input.parse({
      workflowId: "wfr_abc123",
    });
    expect(parsed.workflowId).toBe("wfr_abc123");
  });

  it("parses valid input with internal UUID", () => {
    const parsed = workflowCancel.input.parse({
      workflowId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parsed.workflowId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("parses valid output with cancelled true", () => {
    const parsed = workflowCancel.output.parse({
      cancelled: true,
    });
    expect(parsed.cancelled).toBe(true);
  });

  it("parses valid output with cancelled false", () => {
    const parsed = workflowCancel.output.parse({
      cancelled: false,
    });
    expect(parsed.cancelled).toBe(false);
  });

  it("rejects output with missing cancelled field", () => {
    expect(() =>
      workflowCancel.output.parse({
        success: true,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("workflow.cancel")).toBe(workflowCancel);
  });
});
