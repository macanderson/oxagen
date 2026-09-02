import { describe, expect, it } from "vitest";
import { automationDisable } from "./automation.disable";
import { getCapability } from "../registry";

describe("automation.disable capability", () => {
  // ── input validation ──────────────────────────────────────────────────────

  it("accepts a non-empty automation_id", () => {
    const parsed = automationDisable.input.parse({
      automation_id: "trg_abc123",
    });
    expect(parsed.automation_id).toBe("trg_abc123");
  });

  it("rejects an empty automation_id", () => {
    expect(() =>
      automationDisable.input.parse({ automation_id: "" }),
    ).toThrow();
  });

  it("rejects a missing automation_id", () => {
    expect(() => automationDisable.input.parse({})).toThrow();
  });

  it("rejects a non-string automation_id", () => {
    expect(() =>
      automationDisable.input.parse({ automation_id: 42 }),
    ).toThrow();
  });

  // ── output validation ─────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = automationDisable.output.parse({
      automation_id: "trg_abc123",
      enabled: false,
      status: "paused",
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.status).toBe("paused");
  });

  it("rejects output missing enabled", () => {
    expect(() =>
      automationDisable.output.parse({
        automation_id: "trg_abc123",
        status: "paused",
      }),
    ).toThrow();
  });

  // ── declaration invariants ────────────────────────────────────────────────

  it("is registered under automation.disable", () => {
    expect(getCapability("disable_automation")).toBe(automationDisable);
  });

  it("exposes all four surfaces", () => {
    expect(automationDisable.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
  });

  it("needs no approval — turning an automation off is always safe", () => {
    expect(automationDisable.agent).toMatchObject({
      requiresApproval: false,
      riskLevel: "low",
    });
  });

  it("is tenant-scoped and deny-by-default", () => {
    expect(automationDisable.scoped).toBe(true);
    expect(automationDisable.defaultEffect).toBe("deny");
  });
});
