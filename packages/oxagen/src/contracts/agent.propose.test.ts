import { describe, expect, it } from "vitest";
import {
  agentBranch,
  agentDefinitionPath,
  agentPropose,
  beltOf,
  checkAgentDefinition,
  generatedAgentPath,
  generateSubagentFile,
  instructionsOf,
  resolvesInRegistry,
  SUBAGENT_FILE_HARNESSES,
  subagentFileFor,
} from "./agent.propose";

const REGISTRY = {
  tools: [
    { slug: "github__get_file_contents", versions: [1, 2] },
    { slug: "github__create_pull_request", versions: [3] },
  ],
  capabilities: ["search_graph", "recall_memory"],
};

const DOC = {
  schema: "agent-definition/v0.1",
  slug: "perf-watch",
  name: "Perf watch",
  description: "Watch the performance budget.",
  model_tier: "complex",
  tools: ["github__get_file_contents@2", "search_graph"],
  deny_tools: ["github__merge_pull_request@*"],
  side_effects: ["read", "write"],
  budget: { per_run_micros: 4_000_000 },
  instructions: { body: "Comment with the regression." },
};

const run = (over: Partial<Parameters<typeof checkAgentDefinition>[0]> = {}) =>
  checkAgentDefinition({
    slug: "perf-watch",
    source: 'schema = "agent-definition/v0.1"',
    doc: DOC,
    keyTaken: false,
    registry: REGISTRY,
    exceeded: [],
    ...over,
  });
const failed = (checks: ReturnType<typeof checkAgentDefinition>) =>
  checks.filter((c) => !c.passed).map((c) => c.code);

describe("propose_agent contract", () => {
  it("declares an org Owner or Admin write on the API alone, outside the metering surface", () => {
    expect(agentPropose.name).toBe("propose_agent");
    expect(agentPropose.surfaces).toEqual(["api"]);
    expect(agentPropose.noBillingGate).toBe(true);
    expect(agentPropose.mutates).toBe(true);
    expect(agentPropose.layers).toContain("app");
    expect(agentPropose.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("takes a register_agent slug and refuses anything else (negative)", () => {
    const input = {
      slug: "perf-watch",
      harness: "cursor",
      source: "x",
    };
    expect(agentPropose.input.safeParse(input).success).toBe(true);
    for (const slug of ["Perf", "perf_watch", "-perf", "a".repeat(19)]) {
      expect(agentPropose.input.safeParse({ ...input, slug }).success).toBe(
        false,
      );
    }
    expect(
      agentPropose.input.safeParse({ ...input, harness: "vim" }).success,
    ).toBe(false);
    expect(
      agentPropose.input.safeParse({ ...input, extra: true }).success,
    ).toBe(false);
  });

  it("names the paths and the branch from the slug", () => {
    expect(agentDefinitionPath("perf-watch")).toBe(
      ".oxagen/agents/perf-watch.toml",
    );
    expect(generatedAgentPath("perf-watch")).toBe(
      ".claude/agents/perf-watch.md",
    );
    expect(agentBranch("perf-watch")).toBe("agents/perf-watch");
  });
});

describe("checkAgentDefinition", () => {
  it("passes a complete definition", () => {
    expect(failed(run())).toEqual([]);
    expect(run().map((c) => c.name)).toEqual([
      "schema",
      "key",
      "belt",
      "authority",
      "budget",
      "secrets",
    ]);
  });

  it("fails the schema check on each missing part (negative)", () => {
    expect(failed(run({ doc: null }))).toContain("not_toml");
    expect(failed(run({ doc: { ...DOC, schema: "v0" } }))).toEqual([
      "schema_version",
    ]);
    expect(failed(run({ doc: { ...DOC, slug: "other" } }))).toEqual([
      "slug_mismatch",
    ]);
    expect(failed(run({ doc: { ...DOC, name: " " } }))).toEqual([
      "name_missing",
    ]);
    expect(failed(run({ doc: { ...DOC, model_tier: 3 } }))).toEqual([
      "model_tier_missing",
    ]);
    expect(failed(run({ doc: { ...DOC, tools: "github__*" } }))).toEqual([
      "tools_not_list",
    ]);
    expect(failed(run({ doc: { ...DOC, instructions: {} } }))).toEqual([
      "instructions_missing",
    ]);
  });

  it("fails the key check when the slug is held (negative)", () => {
    expect(failed(run({ keyTaken: true }))).toEqual(["key_taken"]);
  });

  it("fails the belt check on a pattern that resolves to nothing (negative)", () => {
    expect(
      failed(run({ doc: { ...DOC, tools: ["slack__post_message"] } })),
    ).toEqual(["pattern_unresolved"]);
  });

  it("refuses irreversible, an unknown class and a tool past the ceiling (negative)", () => {
    expect(
      failed(run({ doc: { ...DOC, side_effects: ["read", "irreversible"] } })),
    ).toEqual(["irreversible_without_mandate"]);
    expect(failed(run({ doc: { ...DOC, side_effects: ["delete"] } }))).toEqual([
      "side_effect_unknown",
    ]);
    expect(failed(run({ doc: { ...DOC, side_effects: "read" } }))).toEqual([
      "side_effect_unknown",
    ]);
    expect(failed(run({ exceeded: ["search_graph"] }))).toEqual([
      "delegation_ceiling",
    ]);
  });

  it("needs a positive whole per-run budget (negative)", () => {
    for (const budget of [
      undefined,
      {},
      { per_run_micros: 0 },
      { per_run_micros: 1.5 },
    ]) {
      expect(failed(run({ doc: { ...DOC, budget } }))).toEqual([
        "budget_missing",
      ]);
    }
  });

  it("scans the whole file for secrets (negative)", () => {
    expect(failed(run({ source: `token = "ghp_${"a".repeat(36)}"` }))).toEqual([
      "secret_github_token",
    ]);
  });
});

describe("resolvesInRegistry", () => {
  it("resolves slugs, pinned versions, any version, globs and bare capabilities", () => {
    for (const p of [
      "github__get_file_contents",
      "github__get_file_contents@1",
      "github__create_pull_request@*",
      "github__*",
      "search_graph",
      "recall_*",
    ]) {
      expect(resolvesInRegistry(p, REGISTRY)).toBe(true);
    }
  });

  it("refuses a missing version, a malformed pin, and a pinned capability (negative)", () => {
    for (const p of [
      "github__create_pull_request@1",
      "github__create_pull_request@v3",
      "search_graph@1",
      "@2",
      "linear__*",
    ]) {
      expect(resolvesInRegistry(p, REGISTRY)).toBe(false);
    }
  });

  it("reads a glob's dots and brackets literally (negative)", () => {
    expect(resolvesInRegistry("github.*", REGISTRY)).toBe(false);
  });
});

describe("the file readers", () => {
  it("read the belt and the instructions, and fall back when absent", () => {
    expect(beltOf(DOC)).toEqual(DOC.tools);
    expect(beltOf(null)).toEqual([]);
    expect(beltOf({ tools: [1] })).toEqual([]);
    expect(instructionsOf(DOC)).toBe("Comment with the regression.");
    expect(instructionsOf({ instructions: "x" })).toBe("");
  });
});

describe("generateSubagentFile", () => {
  it("writes the name, a quoted description, the source header and the instructions, and no tools", () => {
    const file = generateSubagentFile({
      slug: "perf-watch",
      description: 'Watch the "budget"\n on every PR.',
      instructions: "\nComment with the regression.\n",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(file.split("\n").slice(0, 4)).toEqual([
      "---",
      "name: perf-watch",
      'description: "Watch the \\"budget\\" on every PR."',
      "---",
    ]);
    expect(file).toContain(
      `Generated by Oxagen from .oxagen/agents/perf-watch.toml (sha256:${"a".repeat(64)})`,
    );
    expect(file).toContain("Comment with the regression.\n");
    expect(file).not.toMatch(/^tools:/m);
  });
});

// Creation (propose_agent) and editing (commit_agent_definition) both write
// through subagentFileFor, so the two paths cannot disagree on which harness
// gets a file or what it says (#3501).
describe("subagentFileFor", () => {
  const digest = `sha256:${"b".repeat(64)}`;

  it.each(["claude-code", "cursor", "stella"])(
    "writes .claude/agents/<slug>.md for %s, with the description and instructions of the definition",
    (harness) => {
      expect(SUBAGENT_FILE_HARNESSES).toContain(harness);
      expect(
        subagentFileFor({ slug: "perf-watch", harness, doc: DOC, digest }),
      ).toEqual({
        path: ".claude/agents/perf-watch.md",
        content: generateSubagentFile({
          slug: "perf-watch",
          description: DOC.description,
          instructions: DOC.instructions.body,
          digest,
        }),
      });
    },
  );

  it.each(["codex", "claude-agent-sdk", "custom"])(
    "writes nothing for %s, which reads no subagent file",
    (harness) => {
      expect(
        subagentFileFor({ slug: "perf-watch", harness, doc: DOC, digest }),
      ).toBeNull();
    },
  );

  it("falls back to the name, then the slug, when the definition has no description", () => {
    const { description: _description, ...named } = DOC;
    expect(
      subagentFileFor({
        slug: "perf-watch",
        harness: "claude-code",
        doc: named,
        digest,
      })?.content,
    ).toContain('description: "Perf watch"');
    const { name: _name, ...bare } = named;
    expect(
      subagentFileFor({
        slug: "perf-watch",
        harness: "claude-code",
        doc: bare,
        digest,
      })?.content,
    ).toContain('description: "perf-watch"');
  });
});
