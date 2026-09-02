import { describe, expect, it } from "vitest";
import { automationList } from "./automation.list";
import { getCapability } from "../registry";

describe("automation.list capability", () => {
  // ── input: workspace_id optional ─────────────────────────────────────────

  it("parses empty input (workspace_id is optional)", () => {
    const parsed = automationList.input.parse({});
    expect(parsed.workspace_id).toBeUndefined();
  });

  it("accepts a workspace_id string", () => {
    const parsed = automationList.input.parse({ workspace_id: "ws_abc123" });
    expect(parsed.workspace_id).toBe("ws_abc123");
  });

  it("rejects non-string workspace_id", () => {
    expect(() => automationList.input.parse({ workspace_id: 42 })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses an empty array output", () => {
    const parsed = automationList.output.parse([]);
    expect(parsed).toHaveLength(0);
  });

  it("parses a valid array of automation entries", () => {
    const parsed = automationList.output.parse([
      {
        id: "auto_001",
        name: "Nightly sync",
        status: "active",
        triggerType: "schedule",
        triggers: ["trig_001"],
      },
      {
        id: "auto_002",
        name: "Contact created",
        status: "inactive",
        triggerType: "event",
        triggers: [],
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe("auto_001");
    expect(parsed[0]?.triggerType).toBe("schedule");
    expect(parsed[1]?.triggers).toEqual([]);
  });

  it("parses automation with multiple trigger IDs", () => {
    const parsed = automationList.output.parse([
      {
        id: "auto_003",
        name: "Multi-trigger",
        status: "active",
        triggerType: "api",
        triggers: ["trig_a", "trig_b", "trig_c"],
      },
    ]);
    expect(parsed[0]?.triggers).toHaveLength(3);
  });

  it("rejects output entry missing id", () => {
    expect(() =>
      automationList.output.parse([
        {
          name: "Bad entry",
          status: "active",
          triggerType: "api",
          triggers: [],
        },
      ]),
    ).toThrow();
  });

  it("rejects output entry missing name", () => {
    expect(() =>
      automationList.output.parse([
        {
          id: "auto_001",
          status: "active",
          triggerType: "api",
          triggers: [],
        },
      ]),
    ).toThrow();
  });

  it("rejects output entry missing triggers array", () => {
    expect(() =>
      automationList.output.parse([
        {
          id: "auto_001",
          name: "No triggers",
          status: "active",
          triggerType: "api",
        },
      ]),
    ).toThrow();
  });

  it("rejects non-array output", () => {
    expect(() =>
      automationList.output.parse({
        id: "auto_001",
        name: "Not an array",
        status: "active",
        triggerType: "api",
        triggers: [],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_automations")).toBe(automationList);
  });
});
