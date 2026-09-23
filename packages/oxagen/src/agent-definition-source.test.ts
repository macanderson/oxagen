import { describe, expect, it } from "vitest";
import {
  definitionBudget,
  definitionContainment,
  parseAgentDefinitionSource,
} from "./agent-definition-source";

describe("agent definition source validation", () => {
  it("parses the whole file and preserves removal of a budget", () => {
    expect(
      definitionBudget(
        parseAgentDefinitionSource(
          'schema = "agent-definition/v0.1"\nslug = "agent"\n[instructions]\nbody = "Run."',
        ),
      ),
    ).toBeUndefined();
    expect(
      definitionBudget(
        parseAgentDefinitionSource(
          "budget = { per_run_micros = 1500000, per_day_micros = 9000000 }",
        ),
      ),
    ).toEqual({ perRunMicros: 1500000, perDayMicros: 9000000 });
  });
  it("rejects malformed content after valid schema and slug lines", () => {
    expect(() =>
      parseAgentDefinitionSource(
        'schema = "agent-definition/v0.1"\nslug = "agent"\n[budget',
      ),
    ).toThrow(
      expect.objectContaining({
        code: "conflict",
        reason: "invalid_definition_source",
      }),
    );
  });
  it.each(["nan", "inf", "-inf", "0", "-1", "1.5", '"100"', "true"])(
    "refuses present invalid budget scalar %s",
    (value) => {
      for (const key of ["per_run_micros", "per_day_micros"])
        expect(() =>
          parseAgentDefinitionSource(`budget = { ${key} = ${value} }`),
        ).toThrow(
          expect.objectContaining({
            code: "conflict",
            reason: "invalid_definition_budget",
          }),
        );
    },
  );
  it("rejects unsafe integers at both the TOML boundary and budget reader", () => {
    for (const key of ["per_run_micros", "per_day_micros"]) {
      expect(() =>
        parseAgentDefinitionSource(`budget = { ${key} = 9007199254740992 }`),
      ).toThrow(
        expect.objectContaining({
          code: "conflict",
          reason: "invalid_definition_source",
        }),
      );
      expect(() =>
        definitionBudget({ budget: { [key]: Number.MAX_SAFE_INTEGER + 1 } }),
      ).toThrow(
        expect.objectContaining({
          code: "conflict",
          reason: "invalid_definition_budget",
        }),
      );
    }
  });
  it.each(["1979-05-27T07:32:00Z", "1979-05-27", "07:32:00"])(
    "rejects a TOML date or time as the budget table: %s",
    (value) => {
      expect(() => parseAgentDefinitionSource(`budget = ${value}`)).toThrow(
        expect.objectContaining({ reason: "invalid_definition_budget" }),
      );
    },
  );
  it("rejects malformed budget tables and tool lists", () => {
    expect(() => parseAgentDefinitionSource('budget = "none"')).toThrow(
      /TOML table/,
    );
    expect(() => parseAgentDefinitionSource("tools = [1]")).toThrow(
      /list of strings/,
    );
    expect(() => definitionBudget({ budget: { per_run_micros: NaN } })).toThrow(
      /positive safe integer/,
    );
  });
});

describe("the containment table (ADR-152)", () => {
  it("reads required = true as the requirement and false or absent as none", () => {
    expect(
      definitionContainment(
        parseAgentDefinitionSource("[containment]\nrequired = true"),
      ),
    ).toEqual({ required: true });
    expect(
      definitionContainment(
        parseAgentDefinitionSource("[containment]\nrequired = false"),
      ),
    ).toBeUndefined();
    expect(
      definitionContainment(parseAgentDefinitionSource('slug = "agent"')),
    ).toBeUndefined();
  });
  it.each([
    '[containment]\nrequired = "true"',
    "[containment]\nrequired = 1",
    '[containment]\nrequired = true\nimage = "x"',
    'containment = "required"',
    "[containment]",
  ])("refuses %s", (source) => {
    expect(() => parseAgentDefinitionSource(source)).toThrow(
      expect.objectContaining({ reason: "invalid_definition_source" }),
    );
  });
});
