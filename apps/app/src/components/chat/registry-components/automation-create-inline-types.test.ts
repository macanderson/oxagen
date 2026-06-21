import { describe, it, expect } from "vitest";
import {
  emptyCondition,
  emptyStep,
  TRIGGER_TYPE_OPTIONS,
  EVENT_TYPE_OPTIONS,
  OPERATOR_OPTIONS,
  STEP_TYPE_OPTIONS,
} from "./automation-create-inline-types";

describe("emptyCondition", () => {
  it("returns the correct default shape", () => {
    const cond = emptyCondition();
    expect(cond).toEqual({ property: "", operator: "eq", toValue: "" });
  });

  it("returns a new object on each call (no shared reference)", () => {
    const a = emptyCondition();
    const b = emptyCondition();
    expect(a).not.toBe(b);
    a.property = "mutated";
    expect(b.property).toBe("");
  });
});

describe("emptyStep", () => {
  it("returns the correct default shape", () => {
    const step = emptyStep();
    expect(step).toEqual({ name: "", stepType: "agent", config: {} });
  });

  it("returns a new object on each call (no shared reference)", () => {
    const a = emptyStep();
    const b = emptyStep();
    expect(a).not.toBe(b);
    a.name = "mutated";
    expect(b.name).toBe("");
  });
});

describe("TRIGGER_TYPE_OPTIONS", () => {
  it("has exactly 3 entries", () => {
    expect(TRIGGER_TYPE_OPTIONS).toHaveLength(3);
  });

  it("contains values event, schedule, api in that order", () => {
    const values = TRIGGER_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["event", "schedule", "api"]);
  });
});

describe("EVENT_TYPE_OPTIONS", () => {
  it("has exactly 3 entries", () => {
    expect(EVENT_TYPE_OPTIONS).toHaveLength(3);
  });

  it("contains values node.created, node.updated, node.deleted in that order", () => {
    const values = EVENT_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["node.created", "node.updated", "node.deleted"]);
  });
});

describe("OPERATOR_OPTIONS", () => {
  it("has exactly 4 entries", () => {
    expect(OPERATOR_OPTIONS).toHaveLength(4);
  });

  it("contains values eq, changed, gt, lt in that order", () => {
    const values = OPERATOR_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["eq", "changed", "gt", "lt"]);
  });
});

describe("STEP_TYPE_OPTIONS", () => {
  it("has exactly 6 entries", () => {
    expect(STEP_TYPE_OPTIONS).toHaveLength(6);
  });

  it("contains all expected step type values", () => {
    const values = STEP_TYPE_OPTIONS.map((o) => o.value);
    expect(values).toContain("agent");
    expect(values).toContain("tool");
    expect(values).toContain("condition");
    expect(values).toContain("webhook");
    expect(values).toContain("prompt");
    expect(values).toContain("human_input");
  });
});
