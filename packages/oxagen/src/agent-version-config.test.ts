import { describe, expect, it } from "vitest";
import {
  agentVersionBudget,
  agentVersionContainment,
} from "./agent-version-config";

describe("the budget table of an agent version's config", () => {
  it("reads both ceilings, and none when the config declares no budget", () => {
    expect(agentVersionBudget({})).toBeUndefined();
    expect(agentVersionBudget(null)).toBeUndefined();
    expect(
      agentVersionBudget({
        budget: { per_run_micros: 1500000, per_day_micros: 9000000 },
      }),
    ).toEqual({ perRunMicros: 1500000, perDayMicros: 9000000 });
    expect(agentVersionBudget({ budget: {} })).toEqual({});
  });
  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, "100", true])(
    "refuses the present ceiling %s",
    (value) => {
      for (const key of ["per_run_micros", "per_day_micros"])
        expect(() => agentVersionBudget({ budget: { [key]: value } })).toThrow(
          expect.objectContaining({
            code: "conflict",
            reason: "invalid_agent_config",
          }),
        );
    },
  );
  it("refuses an unsafe integer and a budget that is not an object", () => {
    expect(() =>
      agentVersionBudget({
        budget: { per_run_micros: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(expect.objectContaining({ reason: "invalid_agent_config" }));
    expect(() => agentVersionBudget({ budget: "none" })).toThrow(
      /must be an object/,
    );
    expect(() => agentVersionBudget({ budget: [1] })).toThrow(
      /must be an object/,
    );
    expect(() => agentVersionBudget({ budget: new Date(0) })).toThrow(
      /must be an object/,
    );
  });
});

describe("the containment table (ADR-152)", () => {
  it("reads required true as the requirement, and false or absent as none", () => {
    expect(
      agentVersionContainment({ containment: { required: true } }),
    ).toEqual({ required: true });
    expect(
      agentVersionContainment({ containment: { required: false } }),
    ).toBeUndefined();
    expect(agentVersionContainment({})).toBeUndefined();
  });
  it.each([
    { required: "true" },
    { required: 1 },
    { required: true, image: "x" },
    "required",
    {},
  ])("refuses %j", (containment) => {
    expect(() => agentVersionContainment({ containment })).toThrow(
      expect.objectContaining({ reason: "invalid_agent_config" }),
    );
  });
});
