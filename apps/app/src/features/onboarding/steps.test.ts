// The gate's rail and the register stepper as the recorded state decides them:
// which step is current, which are behind it, and which carry a target the
// operator can open.
import { describe, expect, it } from "vitest";
import { gateRail, parseRegisterStep, registerRail, stepNumber } from "./steps";

const place = { org: "acme", ws: "core-platform" };

/** The flow's steps, written out here so the test names them rather than reading them back off the module under test. */
const registerSteps = ["name", "wrap", "run"] as const;

describe("parseRegisterStep", () => {
  it("reads each step of the flow", () => {
    expect(registerSteps.map(parseRegisterStep)).toEqual([
      "name",
      "wrap",
      "run",
    ]);
  });

  it("refuses a segment that names no step (negative)", () => {
    expect(parseRegisterStep("organization")).toBeNull();
    expect(parseRegisterStep("")).toBeNull();
    expect(parseRegisterStep("NAME")).toBeNull();
  });
});

describe("stepNumber", () => {
  it("counts from one, for the step line", () => {
    expect(registerSteps.map(stepNumber)).toEqual([1, 2, 3]);
  });
});

describe("gateRail", () => {
  it("marks the wrap step current and leaves the run step unreachable", () => {
    expect(gateRail("wrap", place)).toEqual([
      { step: "organization", state: "done", to: null },
      {
        step: "wrap",
        state: "current",
        to: "/acme/core-platform/register/wrap",
      },
      { step: "run", state: "todo", to: null },
    ]);
  });

  it("opens the run step once the gate reached it", () => {
    const rail = gateRail("run", place);
    expect(rail.map((item) => item.state)).toEqual(["done", "done", "current"]);
    expect(rail[2]?.to).toBe("/acme/core-platform/register/run");
  });

  it("leaves every step done once the first frame opened the gate", () => {
    expect(gateRail("unlocked", place).map((item) => item.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("makes the organization step current for a caller with no organization, with no target from here (negative)", () => {
    const rail = gateRail("organization", place);
    expect(rail[0]).toEqual({
      step: "organization",
      state: "current",
      to: null,
    });
    expect(rail.map((item) => item.step)).toEqual([
      "organization",
      "wrap",
      "run",
    ]);
  });
});

describe("registerRail", () => {
  it("carries the agent forward, so a step behind the current one reopens it", () => {
    expect(registerRail("run", place, "agt_1")).toEqual([
      {
        step: "name",
        state: "done",
        to: "/acme/core-platform/register/name?agent=agt_1",
      },
      {
        step: "wrap",
        state: "done",
        to: "/acme/core-platform/register/wrap?agent=agt_1",
      },
      { step: "run", state: "current", to: null },
    ]);
  });

  it("leaves the wrap and run steps closed while no identity exists (negative)", () => {
    expect(registerRail("name", place, null)).toEqual([
      { step: "name", state: "current", to: null },
      { step: "wrap", state: "todo", to: null },
      { step: "run", state: "todo", to: null },
    ]);
  });

  it("opens no later step even when the identity exists (negative)", () => {
    expect(registerRail("name", place, "agt_1")).toEqual([
      { step: "name", state: "current", to: null },
      { step: "wrap", state: "todo", to: null },
      { step: "run", state: "todo", to: null },
    ]);
  });

  it("keeps the name step open on the first step's own address", () => {
    const rail = registerRail("wrap", place, null);
    expect(rail[0]?.to).toBe("/acme/core-platform/register/name");
    expect(rail[2]?.to).toBeNull();
  });
});
