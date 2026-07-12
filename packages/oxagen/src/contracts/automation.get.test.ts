import { describe, expect, it } from "vitest";
import { automationGet } from "./automation.get";
import { getCapability } from "../registry";

describe("automation.get capability", () => {
  // ── name / surfaces ──────────────────────────────────────────────────────

  it("has name 'get_automation'", () => {
    expect(automationGet.name).toBe("get_automation");
  });

  it("declares api, mcp, and agent surfaces", () => {
    expect(automationGet.surfaces).toContain("api");
    expect(automationGet.surfaces).toContain("mcp");
    expect(automationGet.surfaces).toContain("agent");
  });

  it("declares the app layer (the Automations editor page binds it)", () => {
    // The automation editor (automations/[automationId]) reads the full
    // automation via this capability, so it declares the app surface and is
    // bound in apps/app/capability-ui-map.json with an e2e proof.
    expect(automationGet.layers).toContain("app");
  });

  // ── input: automation_id required ────────────────────────────────────────

  it("requires automation_id", () => {
    expect(() => automationGet.input.parse({})).toThrow();
  });

  it("rejects an empty automation_id", () => {
    expect(() => automationGet.input.parse({ automation_id: "" })).toThrow();
  });

  it("accepts a valid automation_id", () => {
    const parsed = automationGet.input.parse({ automation_id: "plt_abc123" });
    expect(parsed.automation_id).toBe("plt_abc123");
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid full output sample", () => {
    const parsed = automationGet.output.parse({
      automation_id: "plt_abc123",
      playbook_id: "plb_xyz789",
      name: "Nightly sync",
      description: "Syncs data every night",
      status: "active",
      triggerType: "schedule",
      enabled: true,
      triggerConfig: { cronExpression: "0 0 * * *" },
      steps: [
        {
          stepKey: "fetch_context",
          name: "Fetch Context",
          stepType: "tool",
          config: { toolId: "tool_1" },
        },
      ],
      runs: [
        {
          id: "run_1",
          status: "completed",
          source: "schedule",
          startedAt: "2026-07-01T00:00:00.000Z",
          completedAt: "2026-07-01T00:01:00.000Z",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.automation_id).toBe("plt_abc123");
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.runs).toHaveLength(1);
  });

  it("parses output with a null description, empty steps, and empty runs", () => {
    const parsed = automationGet.output.parse({
      automation_id: "plt_abc123",
      playbook_id: "plb_xyz789",
      name: "No description",
      description: null,
      status: "inactive",
      triggerType: "event",
      enabled: false,
      triggerConfig: {},
      steps: [],
      runs: [],
    });
    expect(parsed.description).toBeNull();
    expect(parsed.steps).toEqual([]);
    expect(parsed.runs).toEqual([]);
  });

  it("parses runs with null startedAt/completedAt", () => {
    const parsed = automationGet.output.parse({
      automation_id: "plt_abc123",
      playbook_id: "plb_xyz789",
      name: "Pending run",
      description: null,
      status: "active",
      triggerType: "api",
      enabled: true,
      triggerConfig: {},
      steps: [],
      runs: [
        {
          id: "run_2",
          status: "pending",
          source: "manual",
          startedAt: null,
          completedAt: null,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.runs[0]?.startedAt).toBeNull();
    expect(parsed.runs[0]?.completedAt).toBeNull();
  });

  it("rejects an invalid triggerType", () => {
    expect(() =>
      automationGet.output.parse({
        automation_id: "plt_abc123",
        playbook_id: "plb_xyz789",
        name: "Bad trigger type",
        description: null,
        status: "active",
        triggerType: "not_a_real_type",
        enabled: true,
        triggerConfig: {},
        steps: [],
        runs: [],
      }),
    ).toThrow();
  });

  it("rejects output missing automation_id", () => {
    expect(() =>
      automationGet.output.parse({
        playbook_id: "plb_xyz789",
        name: "Missing id",
        description: null,
        status: "active",
        triggerType: "api",
        enabled: true,
        triggerConfig: {},
        steps: [],
        runs: [],
      }),
    ).toThrow();
  });

  it("rejects a step entry missing stepKey", () => {
    expect(() =>
      automationGet.output.parse({
        automation_id: "plt_abc123",
        playbook_id: "plb_xyz789",
        name: "Bad step",
        description: null,
        status: "active",
        triggerType: "api",
        enabled: true,
        triggerConfig: {},
        steps: [{ name: "No key", stepType: "tool", config: {} }],
        runs: [],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_automation")).toBe(automationGet);
  });
});
