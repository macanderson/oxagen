import { describe, expect, it } from "vitest";
import { automationTrigger } from "./automation.trigger";

describe("automation.trigger capability", () => {
  // ── input ──────────────────────────────────────────────────────────────────

  it("parses a valid input with automation_id only", () => {
    const parsed = automationTrigger.input.parse({ automation_id: "trig_abc" });
    expect(parsed.automation_id).toBe("trig_abc");
    expect(parsed.payload).toBeUndefined();
  });

  it("parses input with an optional payload", () => {
    const parsed = automationTrigger.input.parse({
      automation_id: "trig_abc",
      payload: { contactId: "cnt_123", reason: "manual" },
    });
    expect(parsed.payload).toEqual({ contactId: "cnt_123", reason: "manual" });
  });

  it("rejects input missing automation_id", () => {
    expect(() => automationTrigger.input.parse({})).toThrow();
  });

  // ── output ─────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = automationTrigger.output.parse({
      execution_id: "exec_xyz",
      status: "running",
    });
    expect(parsed.execution_id).toBe("exec_xyz");
    expect(parsed.status).toBe("running");
  });

  it("rejects output missing execution_id", () => {
    expect(() =>
      automationTrigger.output.parse({ status: "running" }),
    ).toThrow();
  });
});
