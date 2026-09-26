import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROOT,
  fixtureRepo,
  organizationFixtureRepo,
  readFixtureTree,
} from "./fixture-repo";
import { readTomlFile } from "./files";
import {
  GOVERNANCE_DEFAULTS,
  governanceSchema,
  resolveGovernance,
  type GovernanceFile,
} from "./governance";
import { classifySteeringRepoPath } from "./paths";
import { schemaDirective } from "./schema-ids";
import { DEFAULT_ALWAYS_ON_TOKENS } from "./tokens";

const FIXTURE_TREES: ReadonlyArray<[string, Map<string, string>]> = [
  ["repo", fixtureRepo()],
  ["org-repo", organizationFixtureRepo()],
  ["v0.1/expected", readFixtureTree(join(FIXTURE_ROOT, "v0.1", "expected"))],
];

const GOVERNANCE_FILES = FIXTURE_TREES.flatMap(([tree, files]) =>
  [...files]
    .filter(([path]) => classifySteeringRepoPath(path) === "governance")
    .map(([path, text]) => ({ tree, name: `${tree}/${path}`, text })),
);

function readGovernance(text: string): GovernanceFile {
  const read = readTomlFile(text, "governance/v1", governanceSchema);
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value;
}

function governanceFileOf(tree: string): GovernanceFile {
  const entry = GOVERNANCE_FILES.find((file) => file.tree === tree);
  if (entry === undefined) throw new Error(`${tree} has no governance file`);
  return readGovernance(entry.text);
}

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = governanceSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ path, message }) => ({ path, message }));
}

function governance(value: Record<string, unknown>): GovernanceFile {
  return governanceSchema.parse({ schema: "governance/v1", mode: "team", ...value });
}

describe("governance fixtures", () => {
  it.each(FIXTURE_TREES.map(([tree]) => tree))("%s holds a governance file", (tree) => {
    expect(GOVERNANCE_FILES.some((file) => file.tree === tree)).toBe(true);
  });

  it.each(GOVERNANCE_FILES)("$name reads against governance/v1", ({ text }) => {
    expect(readTomlFile(text, "governance/v1", governanceSchema).ok).toBe(true);
  });

  it("puts every value the workspace repo sets into force", () => {
    const file = governanceFileOf("repo");
    expect(file.steering?.always_on_tokens).toBeTypeOf("number");
    expect(file.ledger).toBeDefined();
    expect(file.memory).toBeDefined();
    expect(file.reviewers?.length).toBeGreaterThan(0);
    expect(resolveGovernance(file)).toEqual({
      ...GOVERNANCE_DEFAULTS,
      ...file.ledger,
      ...file.memory,
      mode: file.mode,
      always_on_tokens: file.steering?.always_on_tokens,
      always_on_tokens_set: true,
    });
  });

  it("fills every default when the organization repo sets only its mode", () => {
    const file = governanceFileOf("org-repo");
    expect(Object.keys(file)).toEqual(["schema", "mode"]);
    expect(resolveGovernance(file)).toEqual({
      ...GOVERNANCE_DEFAULTS,
      mode: file.mode,
      always_on_tokens: DEFAULT_ALWAYS_ON_TOKENS,
      always_on_tokens_set: false,
    });
  });
});

describe("governance schema", () => {
  it("holds Oxagen's defaults", () => {
    expect(GOVERNANCE_DEFAULTS).toEqual({
      rotate: "month",
      max_lines: 10000,
      recall_unreviewed: "same-agent",
      batch_size: 20,
      retire_after_days: 180,
      auto_merge: false,
    });
  });

  it.each(["team", "regulated"])("refuses auto_merge in %s mode", (mode) => {
    expect(
      issuesOf({ schema: "governance/v1", mode, memory: { auto_merge: true } }),
    ).toEqual([
      {
        path: ["memory", "auto_merge"],
        message: "memory.auto_merge must be false when mode is not solo",
      },
    ]);
  });

  it.each([
    ["auto_merge in solo mode", { mode: "solo", memory: { auto_merge: true } }],
    ["auto_merge off in team mode", { mode: "team", memory: { auto_merge: false } }],
    ["a memory table with no auto_merge", { mode: "team", memory: { batch_size: 5 } }],
    ["no memory table", { mode: "team" }],
  ])("accepts %s", (_name, value) => {
    expect(issuesOf({ schema: "governance/v1", ...value })).toEqual([]);
  });

  it("puts the auto_merge issue on the line of the memory table", () => {
    const text = [
      schemaDirective("governance/v1"),
      'schema = "governance/v1"',
      'mode = "team"',
      "",
      "[memory]",
      "auto_merge = true",
      "",
    ].join("\n");
    expect(readTomlFile(text, "governance/v1", governanceSchema)).toEqual({
      ok: false,
      issues: [
        {
          line: 5,
          field: "memory.auto_merge",
          message: "memory.auto_merge must be false when mode is not solo",
        },
      ],
    });
  });

  it.each([
    ["an always-on budget of zero", { steering: { always_on_tokens: 0 } }, ["steering", "always_on_tokens"]],
    ["a fractional always-on budget", { steering: { always_on_tokens: 1.5 } }, ["steering", "always_on_tokens"]],
    ["an always-on budget of on", { steering: { always_on_tokens: "on" } }, ["steering", "always_on_tokens"]],
    ["a steering field it does not know", { steering: { budget: 1 } }, ["steering"]],
    ["a rotation of hour", { ledger: { rotate: "hour" } }, ["ledger", "rotate"]],
    ["a ledger of zero lines", { ledger: { max_lines: 0 } }, ["ledger", "max_lines"]],
    ["recall_unreviewed all", { memory: { recall_unreviewed: "all" } }, ["memory", "recall_unreviewed"]],
    ["a batch of zero", { memory: { batch_size: 0 } }, ["memory", "batch_size"]],
    ["retiring after zero days", { memory: { retire_after_days: 0 } }, ["memory", "retire_after_days"]],
    ["auto_merge as text", { memory: { auto_merge: "yes" } }, ["memory", "auto_merge"]],
    ["a reviewer with no paths", { reviewers: [{ paths: [], group: "billing-leads" }] }, ["reviewers", 0, "paths"]],
    [
      "a reviewer with an empty path",
      { reviewers: [{ paths: [""], group: "billing-leads" }] },
      ["reviewers", 0, "paths", 0],
    ],
    [
      "a reviewer group with capitals",
      { reviewers: [{ paths: ["steering/**"], group: "Billing Leads" }] },
      ["reviewers", 0, "group"],
    ],
    ["a top-level field it does not know", { colour: "blue" }, []],
    ["another schema", { schema: "governance/v2" }, ["schema"]],
    ["an unknown mode", { mode: "chaos" }, ["mode"]],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf({ schema: "governance/v1", mode: "team", ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("resolveGovernance", () => {
  const DEFAULT_SETTINGS = {
    ...GOVERNANCE_DEFAULTS,
    mode: "team",
    always_on_tokens: DEFAULT_ALWAYS_ON_TOKENS,
    always_on_tokens_set: false,
  };

  it.each([
    { name: "no tables", file: {}, settings: {} },
    { name: "an empty steering table", file: { steering: {} }, settings: {} },
    {
      name: "a budget",
      file: { steering: { always_on_tokens: 2500 } },
      settings: { always_on_tokens: 2500, always_on_tokens_set: true },
    },
    {
      name: "the budget turned off",
      file: { steering: { always_on_tokens: "off" } },
      settings: { always_on_tokens: null, always_on_tokens_set: true },
    },
    { name: "an empty ledger table", file: { ledger: {} }, settings: {} },
    { name: "a rotation only", file: { ledger: { rotate: "week" } }, settings: { rotate: "week" } },
    { name: "a line limit only", file: { ledger: { max_lines: 500 } }, settings: { max_lines: 500 } },
    { name: "an empty memory table", file: { memory: {} }, settings: {} },
    {
      name: "recall turned off in team mode",
      file: { memory: { recall_unreviewed: "off" } },
      settings: { recall_unreviewed: "off" },
    },
    {
      name: "recall set in regulated mode",
      file: { mode: "regulated", memory: { recall_unreviewed: "same-agent" } },
      settings: { mode: "regulated", recall_unreviewed: "off" },
    },
    {
      name: "regulated mode with no memory table",
      file: { mode: "regulated" },
      settings: { mode: "regulated", recall_unreviewed: "off" },
    },
    {
      name: "every memory setting in solo mode",
      file: {
        mode: "solo",
        memory: { batch_size: 5, retire_after_days: 30, auto_merge: true },
      },
      settings: { mode: "solo", batch_size: 5, retire_after_days: 30, auto_merge: true },
    },
  ])("resolves $name", ({ file, settings }) => {
    expect(resolveGovernance(governance(file))).toEqual({ ...DEFAULT_SETTINGS, ...settings });
  });
});
