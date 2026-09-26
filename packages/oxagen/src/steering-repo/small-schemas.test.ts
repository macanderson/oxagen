import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentHarnessSchema } from "../contracts/agent.list";
import { toolSideEffectClassSchema } from "../contracts/tool.classification";
import { agentSchema } from "./agent";
import {
  REPO_HEALTH_STATES,
  repoHealthSchema,
  settingsDifferenceSchema,
} from "./health";
import { toolbeltSchema } from "./toolbelt";

/** The issues a schema reports for a value, or none when it accepts it. */
function issuesOf(schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues;
}

const agent = {
  schema: "agent/v1",
  name: "a-intel.core.ci-reviewer",
  label: "CI reviewer",
  operator: "platform-team",
  runtime: "ci-linux-01",
  harness: "codex",
};

const toolbelt = {
  schema: "toolbelt/v1",
  name: "refunds",
  label: "Refunds",
  description: "Look up charges and refund them.",
  tools: ["stripe__list_charges", "billing__*"],
};

describe("agentSchema", () => {
  it("accepts an agent file and returns it unchanged", () => {
    const parsed = agentSchema.safeParse(agent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(agent);
  });

  it.each([...agentHarnessSchema.options])(
    "accepts the harness %s",
    (harness) => {
      expect(issuesOf(agentSchema, { ...agent, harness })).toEqual([]);
    },
  );

  it("accepts a label of 80 characters", () => {
    expect(issuesOf(agentSchema, { ...agent, label: "x".repeat(80) })).toEqual(
      [],
    );
  });

  it.each(["toolbelt", "budget", "environment"])(
    "refuses the field %s, which waits until customers ask",
    (field) => {
      const issues = issuesOf(agentSchema, { ...agent, [field]: "x" });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: "unrecognized_keys", keys: [field] });
    },
  );

  it.each([
    ["schema", "agent/v2"],
    ["schema", "toolbelt/v1"],
    ["name", "a"],
    ["name", "A-intel.core.ci-reviewer"],
    ["label", ""],
    ["label", "x".repeat(81)],
    ["operator", "Platform"],
    ["operator", ""],
    ["runtime", "CI-linux"],
    ["runtime", "ci--linux"],
    ["runtime", ""],
    ["harness", "gemini"],
  ])("refuses %s set to %j", (field, value) => {
    const issues = issuesOf(agentSchema, { ...agent, [field]: value });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.path).toEqual([field]);
  });

  it("names the lineage rule when the name is not a lineage", () => {
    const issues = issuesOf(agentSchema, { ...agent, name: "-core" });
    expect(issues.map((issue) => issue.message)).toEqual([
      "a lineage is lowercase letters, digits, dots, and hyphens, and starts and ends with a letter or digit",
    ]);
  });

  it("names the slug rule when the runtime is not a slug", () => {
    const issues = issuesOf(agentSchema, { ...agent, runtime: "ci_linux" });
    expect(issues.map((issue) => issue.message)).toEqual([
      "lowercase letters and digits, separated by single hyphens",
    ]);
  });

  it.each(["schema", "name", "label", "operator", "runtime", "harness"])(
    "refuses a file with no %s",
    (field) => {
      const partial: Record<string, unknown> = { ...agent };
      delete partial[field];
      const issues = issuesOf(agentSchema, partial);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual([field]);
    },
  );

  it("carries a description on each described field", () => {
    const { shape } = agentSchema;
    expect(shape.name.description).toBe(
      "The agent's name and the file's name: agents/<name>.toml.",
    );
    expect(shape.operator.description).toBe("An Oxagen member or team.");
    expect(shape.runtime.description).toBe("A runtime enrolled in Oxagen.");
    expect(shape.harness.description).toBe(
      "The harness, or the framework adapter, the agent runs in.",
    );
  });
});

describe("toolbeltSchema", () => {
  it("accepts a toolbelt with no side effect filter", () => {
    const parsed = toolbeltSchema.safeParse(toolbelt);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(toolbelt);
    expect(parsed.data.side_effects).toBeUndefined();
  });

  it("accepts a toolbelt with no description", () => {
    const { description: _description, ...rest } = toolbelt;
    expect(issuesOf(toolbeltSchema, rest)).toEqual([]);
  });

  it("accepts a side effect filter", () => {
    const parsed = toolbeltSchema.safeParse({
      ...toolbelt,
      side_effects: ["read", "write"],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.side_effects).toEqual(["read", "write"]);
  });

  it.each([...toolSideEffectClassSchema.options])(
    "accepts the side effect %s",
    (effect) => {
      expect(
        issuesOf(toolbeltSchema, { ...toolbelt, side_effects: [effect] }),
      ).toEqual([]);
    },
  );

  it("accepts a description of 200 characters", () => {
    expect(
      issuesOf(toolbeltSchema, { ...toolbelt, description: "d".repeat(200) }),
    ).toEqual([]);
  });

  it("refuses a toolbelt with no tools", () => {
    const issues = issuesOf(toolbeltSchema, { ...toolbelt, tools: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "too_small", path: ["tools"] });
  });

  it("refuses a tool listed twice and names the repeat", () => {
    const issues = issuesOf(toolbeltSchema, {
      ...toolbelt,
      tools: ["billing__*", "billing__*"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "custom",
      path: ["tools", 1],
      message: 'tools lists "billing__*" twice',
    });
  });

  it("reports each repeat of a tool at its own index", () => {
    const issues = issuesOf(toolbeltSchema, {
      ...toolbelt,
      tools: ["a__*", "b__*", "a__*", "a__*"],
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      ["tools", 2],
      ["tools", 3],
    ]);
  });

  it("refuses a side effect listed twice and names the repeat", () => {
    const issues = issuesOf(toolbeltSchema, {
      ...toolbelt,
      side_effects: ["read", "write", "read"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "custom",
      path: ["side_effects", 2],
      message: 'side_effects lists "read" twice',
    });
  });

  it("refuses an empty side effect filter", () => {
    const issues = issuesOf(toolbeltSchema, { ...toolbelt, side_effects: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "too_small",
      path: ["side_effects"],
    });
  });

  it("refuses a side effect class the contract does not have", () => {
    const issues = issuesOf(toolbeltSchema, {
      ...toolbelt,
      side_effects: ["delete"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["side_effects", 0]);
  });

  it("refuses a tool that is not a tool target", () => {
    const issues = issuesOf(toolbeltSchema, {
      ...toolbelt,
      tools: ["billing__x*"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["tools", 0],
      message: "a tool target is <server>__<tool> or <server>__*",
    });
  });

  it.each([
    ["schema", "toolbelt/v2"],
    ["name", "Refunds"],
    ["name", ""],
    ["name", "r".repeat(41)],
    ["label", ""],
    ["label", "x".repeat(81)],
    ["description", ""],
    ["description", "d".repeat(201)],
    ["tools", "billing__*"],
    ["side_effects", "read"],
  ])("refuses %s set to %j", (field, value) => {
    const issues = issuesOf(toolbeltSchema, { ...toolbelt, [field]: value });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.path[0]).toBe(field);
  });

  it("refuses a field the format does not have", () => {
    const issues = issuesOf(toolbeltSchema, { ...toolbelt, agents: ["x"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["agents"],
    });
  });

  it("carries a description on each described field", () => {
    const { shape } = toolbeltSchema;
    expect(shape.name.description).toBe(
      "The toolbelt's name and the file's name: tools/toolbelts/<name>.toml.",
    );
    expect(shape.tools.description).toBe(
      "Tool names across servers, and <server>__* for every imported tool of one server.",
    );
    expect(shape.side_effects.description).toBe(
      "Keep only tools whose side effect is one of these.",
    );
  });
});

describe("repoHealthSchema", () => {
  it("lists the four health states", () => {
    expect([...REPO_HEALTH_STATES]).toEqual([
      "healthy",
      "drifted",
      "disconnected",
      "diverged",
    ]);
    expect(repoHealthSchema.options).toEqual([...REPO_HEALTH_STATES]);
  });

  it.each([...REPO_HEALTH_STATES])("accepts %s", (state) => {
    expect(repoHealthSchema.safeParse(state).success).toBe(true);
  });

  it.each(["unknown", "Healthy", "", 1])("refuses %j", (state) => {
    expect(repoHealthSchema.safeParse(state).success).toBe(false);
  });
});

describe("settingsDifferenceSchema", () => {
  const difference = {
    setting: "rulesets.oxagen_merges",
    expected: { enforcement: "active" },
    actual: { enforcement: "disabled" },
    changed_by: "mac",
    changed_at: "2026-09-26T10:00:00Z",
  };

  it("accepts a difference with who changed it and when", () => {
    const parsed = settingsDifferenceSchema.safeParse(difference);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(difference);
  });

  it("accepts a difference whose author and time are unknown", () => {
    expect(
      issuesOf(settingsDifferenceSchema, {
        ...difference,
        changed_by: null,
        changed_at: null,
      }),
    ).toEqual([]);
  });

  it.each([
    ["a string", "main"],
    ["a number", 2],
    ["a boolean", false],
    ["null", null],
    ["a list", ["a", "b"]],
  ])("accepts %s as the expected and actual values", (_label, value) => {
    expect(
      issuesOf(settingsDifferenceSchema, {
        ...difference,
        expected: value,
        actual: value,
      }),
    ).toEqual([]);
  });

  it.each([
    ["setting", ""],
    ["setting", 1],
    ["changed_by", 42],
    ["changed_at", "yesterday"],
    ["changed_at", "2026-09-26T10:00:00"],
  ])("refuses %s set to %j", (field, value) => {
    const issues = issuesOf(settingsDifferenceSchema, {
      ...difference,
      [field]: value,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual([field]);
  });

  it.each(["setting", "changed_by", "changed_at"])(
    "refuses a difference with no %s",
    (field) => {
      const partial: Record<string, unknown> = { ...difference };
      delete partial[field];
      const issues = issuesOf(settingsDifferenceSchema, partial);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual([field]);
    },
  );

  it("refuses a field the difference does not have", () => {
    const issues = issuesOf(settingsDifferenceSchema, {
      ...difference,
      repository: "github.com/a-intel/platform",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["repository"],
    });
  });

  it("describes the setting as a path in the baseline", () => {
    expect(settingsDifferenceSchema.shape.setting.description).toBe(
      "The setting's path in the baseline, such as rulesets.oxagen_merges.",
    );
  });
});
