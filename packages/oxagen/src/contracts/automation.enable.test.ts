import { describe, expect, it } from "vitest";
import { automationEnable } from "./automation.enable";
import { getCapability } from "../registry";

describe("automation.enable capability", () => {
  // ── input validation ──────────────────────────────────────────────────────

  it("accepts a non-empty automation_id", () => {
    const parsed = automationEnable.input.parse({
      automation_id: "trg_abc123",
    });
    expect(parsed.automation_id).toBe("trg_abc123");
  });

  it("rejects an empty automation_id", () => {
    expect(() => automationEnable.input.parse({ automation_id: "" })).toThrow();
  });

  it("rejects a missing automation_id", () => {
    expect(() => automationEnable.input.parse({})).toThrow();
  });

  it("rejects a non-string automation_id", () => {
    expect(() => automationEnable.input.parse({ automation_id: 42 })).toThrow();
  });

  // ── output validation ─────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = automationEnable.output.parse({
      automation_id: "trg_abc123",
      enabled: true,
      status: "active",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.status).toBe("active");
  });

  it("rejects output missing enabled", () => {
    expect(() =>
      automationEnable.output.parse({
        automation_id: "trg_abc123",
        status: "active",
      }),
    ).toThrow();
  });

  // ── declaration invariants ────────────────────────────────────────────────

  it("is registered under automation.enable", () => {
    expect(getCapability("enable_automation")).toBe(automationEnable);
  });

  it("exposes all four surfaces so every entry point can enable with its own human gate", () => {
    expect(automationEnable.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
  });

  it("requires approval at high risk — the human gate must never be weakened", () => {
    expect(automationEnable.agent).toMatchObject({
      requiresApproval: true,
      riskLevel: "high",
    });
  });

  it("is tenant-scoped and deny-by-default", () => {
    expect(automationEnable.scoped).toBe(true);
    expect(automationEnable.defaultEffect).toBe("deny");
  });
});
