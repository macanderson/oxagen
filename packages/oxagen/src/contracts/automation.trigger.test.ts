import { describe, expect, it } from "vitest";
import { automationTrigger } from "./automation.trigger";
import { getCapability } from "../registry";

describe("automation.trigger capability", () => {
  // ── input: automation_id required ─────────────────────────────────────────

  it("parses minimal input with only automation_id", () => {
    const parsed = automationTrigger.input.parse({ automation_id: "trig_abc" });
    expect(parsed.automation_id).toBe("trig_abc");
  });

  it("rejects missing automation_id", () => {
    expect(() => automationTrigger.input.parse({})).toThrow();
  });

  it("rejects non-string automation_id", () => {
    expect(() =>
      automationTrigger.input.parse({ automation_id: 123 }),
    ).toThrow();
  });

  // ── input: payload optional ───────────────────────────────────────────────

  it("defaults payload to undefined when not provided", () => {
    const parsed = automationTrigger.input.parse({ automation_id: "trig_abc" });
    expect(parsed.payload).toBeUndefined();
  });

  it("accepts a payload record with arbitrary keys", () => {
    const parsed = automationTrigger.input.parse({
      automation_id: "trig_abc",
      payload: { userId: "u_001", action: "sync", count: 5, enabled: true },
    });
    expect(parsed.payload?.["userId"]).toBe("u_001");
    expect(parsed.payload?.["count"]).toBe(5);
  });

  it("accepts an empty payload record", () => {
    const parsed = automationTrigger.input.parse({
      automation_id: "trig_abc",
      payload: {},
    });
    expect(parsed.payload).toEqual({});
  });

  it("rejects payload as a non-object (array)", () => {
    expect(() =>
      automationTrigger.input.parse({
        automation_id: "trig_abc",
        payload: ["item"],
      }),
    ).toThrow();
  });

  it("rejects payload as a string", () => {
    expect(() =>
      automationTrigger.input.parse({
        automation_id: "trig_abc",
        payload: "not-an-object",
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = automationTrigger.output.parse({
      execution_id: "exec_xyz789",
      status: "queued",
    });
    expect(parsed.execution_id).toBe("exec_xyz789");
    expect(parsed.status).toBe("queued");
  });

  it("accepts any string status value", () => {
    const parsed = automationTrigger.output.parse({
      execution_id: "exec_001",
      status: "running",
    });
    expect(parsed.status).toBe("running");
  });

  it("rejects output missing execution_id", () => {
    expect(() =>
      automationTrigger.output.parse({ status: "queued" }),
    ).toThrow();
  });

  it("rejects output missing status", () => {
    expect(() =>
      automationTrigger.output.parse({ execution_id: "exec_001" }),
    ).toThrow();
  });

  it("rejects output with non-string execution_id", () => {
    expect(() =>
      automationTrigger.output.parse({ execution_id: 42, status: "queued" }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("automation.trigger")).toBe(automationTrigger);
  });
});
