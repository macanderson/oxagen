import { describe, expect, it } from "vitest";
import { automationCreate } from "./automation.create";
import { getCapability } from "../registry";

describe("automation.create capability", () => {
  // ── name bounds ───────────────────────────────────────────────────────────

  it("accepts name of length 1 (min)", () => {
    const parsed = automationCreate.input.parse({
      name: "A",
      triggerType: "api",
    });
    expect(parsed.name).toBe("A");
  });

  it("accepts name of length 120 (max)", () => {
    const name = "a".repeat(120);
    const parsed = automationCreate.input.parse({ name, triggerType: "api" });
    expect(parsed.name).toBe(name);
  });

  it("rejects name of length 0 (below min)", () => {
    expect(() =>
      automationCreate.input.parse({ name: "", triggerType: "api" }),
    ).toThrow();
  });

  it("rejects name of length 121 (above max)", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "a".repeat(121),
        triggerType: "api",
      }),
    ).toThrow();
  });

  it("rejects non-string name", () => {
    expect(() =>
      automationCreate.input.parse({ name: 42, triggerType: "api" }),
    ).toThrow();
  });

  it("rejects missing name", () => {
    expect(() =>
      automationCreate.input.parse({ triggerType: "api" }),
    ).toThrow();
  });

  // ── description bounds ────────────────────────────────────────────────────

  it("accepts description up to 500 chars (max)", () => {
    const description = "d".repeat(500);
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
      description,
    });
    expect(parsed.description).toBe(description);
  });

  it("rejects description of 501 chars (above max)", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "My automation",
        triggerType: "api",
        description: "d".repeat(501),
      }),
    ).toThrow();
  });

  it("omits description when not provided", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
    });
    expect(parsed.description).toBeUndefined();
  });

  // ── triggerType enum ──────────────────────────────────────────────────────

  it("accepts triggerType='event'", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "event",
    });
    expect(parsed.triggerType).toBe("event");
  });

  it("accepts triggerType='schedule'", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "schedule",
    });
    expect(parsed.triggerType).toBe("schedule");
  });

  it("accepts triggerType='api'", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
    });
    expect(parsed.triggerType).toBe("api");
  });

  it("rejects unknown triggerType", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "My automation",
        triggerType: "webhook",
      }),
    ).toThrow();
  });

  it("rejects missing triggerType", () => {
    expect(() =>
      automationCreate.input.parse({ name: "My automation" }),
    ).toThrow();
  });

  // ── triggerConfig default ─────────────────────────────────────────────────

  it("defaults triggerConfig to {}", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
    });
    expect(parsed.triggerConfig).toEqual({});
  });

  it("accepts triggerConfig with schedule fields", () => {
    const parsed = automationCreate.input.parse({
      name: "Weekly run",
      triggerType: "schedule",
      triggerConfig: {
        cronExpression: "0 9 * * 1",
        timezone: "America/New_York",
      },
    });
    expect(parsed.triggerConfig.cronExpression).toBe("0 9 * * 1");
    expect(parsed.triggerConfig.timezone).toBe("America/New_York");
  });

  it("accepts triggerConfig with event fields", () => {
    const parsed = automationCreate.input.parse({
      name: "Contact watcher",
      triggerType: "event",
      triggerConfig: {
        entityType: "Contact",
        eventType: "node.updated",
      },
    });
    expect(parsed.triggerConfig.entityType).toBe("Contact");
    expect(parsed.triggerConfig.eventType).toBe("node.updated");
  });

  it("rejects unknown eventType in triggerConfig", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "My automation",
        triggerType: "event",
        triggerConfig: { eventType: "node.archived" },
      }),
    ).toThrow();
  });

  // ── propertyConditions operator default ──────────────────────────────────

  it("defaults propertyConditions operator to 'eq'", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "event",
      triggerConfig: {
        propertyConditions: [{ property: "status" }],
      },
    });
    expect(parsed.triggerConfig.propertyConditions?.[0]?.operator).toBe("eq");
  });

  it("accepts all valid operator values", () => {
    for (const op of ["eq", "gt", "lt", "changed"] as const) {
      const parsed = automationCreate.input.parse({
        name: "My automation",
        triggerType: "event",
        triggerConfig: {
          propertyConditions: [{ property: "value", operator: op }],
        },
      });
      expect(parsed.triggerConfig.propertyConditions?.[0]?.operator).toBe(op);
    }
  });

  it("rejects unknown operator in propertyConditions", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "My automation",
        triggerType: "event",
        triggerConfig: {
          propertyConditions: [{ property: "status", operator: "gte" }],
        },
      }),
    ).toThrow();
  });

  it("accepts propertyConditions with fromValue and toValue", () => {
    const parsed = automationCreate.input.parse({
      name: "Status change",
      triggerType: "event",
      triggerConfig: {
        propertyConditions: [
          {
            property: "status",
            fromValue: "pending",
            toValue: "active",
            operator: "eq",
          },
        ],
      },
    });
    const cond = parsed.triggerConfig.propertyConditions?.[0];
    expect(cond?.fromValue).toBe("pending");
    expect(cond?.toValue).toBe("active");
  });

  // ── steps default ─────────────────────────────────────────────────────────

  it("defaults steps to []", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
    });
    expect(parsed.steps).toEqual([]);
  });

  it("accepts a valid steps array", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
      steps: [{ name: "Run agent", stepType: "agent" }],
    });
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]?.stepType).toBe("agent");
  });

  it("defaults step config to {}", () => {
    const parsed = automationCreate.input.parse({
      name: "My automation",
      triggerType: "api",
      steps: [{ name: "Call webhook", stepType: "webhook" }],
    });
    expect(parsed.steps[0]?.config).toEqual({});
  });

  it("accepts all valid stepType values", () => {
    const types = [
      "agent",
      "tool",
      "condition",
      "webhook",
      "prompt",
      "human_input",
    ] as const;
    for (const stepType of types) {
      const parsed = automationCreate.input.parse({
        name: "My automation",
        triggerType: "api",
        steps: [{ name: "Step", stepType }],
      });
      expect(parsed.steps[0]?.stepType).toBe(stepType);
    }
  });

  it("rejects unknown stepType", () => {
    expect(() =>
      automationCreate.input.parse({
        name: "My automation",
        triggerType: "api",
        steps: [{ name: "Step", stepType: "email" }],
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = automationCreate.output.parse({
      automation_id: "trig_abc123",
      playbook_id: "pb_xyz789",
      name: "My automation",
      status: "active",
      triggerType: "api",
      enabled: true,
    });
    expect(parsed.automation_id).toBe("trig_abc123");
    expect(parsed.playbook_id).toBe("pb_xyz789");
    expect(parsed.name).toBe("My automation");
    expect(parsed.status).toBe("active");
    expect(parsed.triggerType).toBe("api");
    expect(parsed.enabled).toBe(true);
  });

  it("rejects output missing enabled", () => {
    expect(() =>
      automationCreate.output.parse({
        automation_id: "trig_abc123",
        playbook_id: "pb_xyz789",
        name: "My automation",
        status: "active",
        triggerType: "api",
      }),
    ).toThrow();
  });

  it("rejects output missing automation_id", () => {
    expect(() =>
      automationCreate.output.parse({
        playbook_id: "pb_xyz789",
        name: "My automation",
        status: "active",
        triggerType: "api",
      }),
    ).toThrow();
  });

  it("rejects output missing playbook_id", () => {
    expect(() =>
      automationCreate.output.parse({
        automation_id: "trig_abc123",
        name: "My automation",
        status: "active",
        triggerType: "api",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("create_automation")).toBe(automationCreate);
  });
});
