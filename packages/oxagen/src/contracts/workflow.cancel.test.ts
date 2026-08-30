import { describe, expect, it } from "vitest";
import { workflowCancel } from "./workflow.cancel";
import { getCapability } from "../registry";

describe("workflow.cancel capability", () => {
  it("is registered", () => {
    expect(getCapability("cancel_workflow")).toBeDefined();
  });

  it("parses a valid input with a public ID", () => {
    expect(() =>
      workflowCancel.input.parse({ workflowId: "wfr_abc123" }),
    ).not.toThrow();
  });

  it("parses a valid input with an internal UUID", () => {
    expect(() =>
      workflowCancel.input.parse({
        workflowId: "018fae12-0000-7000-8000-000000000001",
      }),
    ).not.toThrow();
  });

  it("rejects input missing workflowId", () => {
    expect(() => workflowCancel.input.parse({})).toThrow();
  });

  it("rejects input with empty workflowId", () => {
    expect(() => workflowCancel.input.parse({ workflowId: "" })).toThrow();
  });

  it("parses a valid output when cancelled=true", () => {
    expect(() =>
      workflowCancel.output.parse({ cancelled: true }),
    ).not.toThrow();
  });

  it("parses a valid output when cancelled=false", () => {
    expect(() =>
      workflowCancel.output.parse({ cancelled: false }),
    ).not.toThrow();
  });

  it("rejects output missing cancelled field", () => {
    expect(() => workflowCancel.output.parse({})).toThrow();
  });

  it("has correct defaultEffect and defaultRoles", () => {
    expect(workflowCancel.defaultEffect).toBe("deny");
    expect(workflowCancel.defaultRoles?.org?.Owner).toBe("allow");
    expect(workflowCancel.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
