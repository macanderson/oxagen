import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_RECORD_SCHEMA } from "@oxagen/oxagen/steering-repo/paths";
import {
  FIXTURE_ROOT,
  readFixtureTree,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  convertOxagenTree,
  IMPORT_WORKSPACE_BRANCH,
  importPullRequestBody,
  renderIdTable,
  type ImportBranch,
  type OxagenTreeConversion,
  type OxagenTreeInput,
} from "./convert";
import {
  branchScopeRefusal,
  IMPORT_BRANCH,
  IMPORT_REPLACES_PATH,
  parseReplacesFile,
  STEERING_PR_MAX_FILES,
} from "./stamp";

const V01 = join(FIXTURE_ROOT, "v0.1");
const INPUT = readFixtureTree(join(V01, "input"));
const EXPECTED = readFixtureTree(join(V01, "expected"));
const CONVERSION = JSON.parse(readFileSync(join(V01, "conversion.json"), "utf8")) as {
  set_id: string;
  folder: string;
  records: unknown[];
  dropped: Record<string, string[]>;
  relinked: string;
};

const RELINKED = "github.com/a-intel/platform";
const REFUNDS_RULE = "ctx.a-intel.refunds-over-100";

function input(over: Partial<OxagenTreeInput> = {}): OxagenTreeInput {
  return {
    files: INPUT,
    organization: "a-intel",
    workspace: "core-platform",
    relinked: RELINKED,
    ruleKinds: { [REFUNDS_RULE]: "business-rule" },
    workspaceToml: null,
    governanceToml: null,
    ...over,
  };
}

function converted(over: Partial<OxagenTreeInput> = {}): OxagenTreeConversion {
  const result = convertOxagenTree(input(over));
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.conversion;
}

function withFiles(extra: Record<string, string>, base = INPUT): Map<string, string> {
  return new Map([...base, ...Object.entries(extra)]);
}

/** Every file the steering PRs write, except the replaces files the stamp deletes. */
function written(conversion: OxagenTreeConversion): Map<string, string> {
  const files = new Map<string, string>();
  for (const branch of conversion.branches) {
    for (const file of branch.files) {
      if (file.path !== IMPORT_REPLACES_PATH) files.set(file.path, file.content);
    }
  }
  return files;
}

function importBatches(conversion: OxagenTreeConversion): ImportBranch[] {
  return conversion.branches.filter((b) => b.branch.startsWith(IMPORT_BRANCH));
}

function replacesOf(branch: ImportBranch): Map<string, string> | null {
  const file = branch.files.find((f) => f.path === IMPORT_REPLACES_PATH);
  if (!file) return null;
  const parsed = parseReplacesFile(file.content);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.replaces;
}

/** A v0.1 record file holding one fact. */
function legacyFact(n: number): [string, string] {
  const slug = `fact-${String(n).padStart(3, "0")}`;
  const text = [
    `schema = "${LEGACY_RECORD_SCHEMA}"`,
    'set_id = "a-intel.core-platform"',
    "",
    "[[record]]",
    `lineage_id = "ctx.a-intel.${slug}"`,
    `label = "Fact ${n}"`,
    `record_id = "rec_a_intel_${slug.replace(/-/g, "_")}_${n.toString(16).padStart(12, "0")}"`,
    'kind = "fact"',
    `statement = "Fact number ${n} holds."`,
    'sharing_scope = "workspace"',
    "",
    "[record.steering]",
    'force = "info"',
    "",
  ].join("\n");
  return [`.oxagen/rules/ctx.a-intel.${slug}.toml`, text];
}

function legacyFacts(count: number): Map<string, string> {
  return new Map(Array.from({ length: count }, (_, i) => legacyFact(i)));
}

/** A v0.1 skill folder: SKILL.md and `assets` more files. */
function legacySkill(name: string, assets: number): Record<string, string> {
  const files: Record<string, string> = {
    [`.oxagen/skills/${name}/SKILL.md`]: [
      "---",
      `name: ${name}`,
      "description: Write the release notes for a merged pull request.",
      "---",
      "",
      "Read the pull request, then write one line per change.",
      "",
    ].join("\n"),
  };
  for (let i = 0; i < assets; i += 1) {
    files[`.oxagen/skills/${name}/ref-${String(i).padStart(3, "0")}.md`] = `Reference ${i}.\n`;
  }
  return files;
}

describe("convertOxagenTree: the v0.1 fixture", () => {
  it("writes the v1 fixture's files byte for byte", () => {
    const conversion = converted();
    expect(written(conversion)).toEqual(EXPECTED);
  });

  it("answers the fixture's set, records, and dropped keys", () => {
    const conversion = converted();
    const byTo = (a: { to: string }, b: { to: string }) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
    expect(conversion.set).toBe(CONVERSION.set_id);
    expect([...conversion.records].sort(byTo)).toEqual(
      [...(CONVERSION.records as { to: string }[])].sort(byTo),
    );
    expect(conversion.dropped).toEqual(CONVERSION.dropped);
    expect(RELINKED).toBe(CONVERSION.relinked);
    for (const record of conversion.records) {
      expect(record.to.startsWith(`${CONVERSION.folder}/`)).toBe(true);
    }
  });

  it("opens one import batch and the workspace.toml PR", () => {
    const conversion = converted();
    expect(conversion.branches.map((b) => b.branch)).toEqual([
      IMPORT_BRANCH,
      IMPORT_WORKSPACE_BRANCH,
    ]);
    const [batch] = conversion.branches;
    expect(batch!.files.map((f) => f.path)).toEqual([
      "steering/governance.toml",
      "steering/imported/a-intel.core-platform.no-push-to-main.md",
      "steering/imported/a-intel.core-platform.production-branch.md",
      "steering/imported/a-intel.core-platform.refunds-over-100.md",
      IMPORT_REPLACES_PATH,
    ]);
    expect(batch!.records).toHaveLength(3);
    for (const branch of conversion.branches) {
      expect(branchScopeRefusal(branch.branch, branch.files.map((f) => f.path))).toBeNull();
    }
  });

  it("commits each record's old id in the replaces file", () => {
    const conversion = converted();
    const expected = new Map(
      conversion.records.map((record) => [record.to, record.old_id as string]),
    );
    expect(replacesOf(conversion.branches[0]!)).toEqual(expected);
    expect(conversion.replaces).toEqual(expected);
  });

  it("removes every converted file from the old repository", () => {
    expect(converted().cleanupPaths).toEqual([...INPUT.keys()].sort());
    expect(converted().unconverted).toEqual([]);
  });
});

describe("convertOxagenTree: choices a person makes", () => {
  it("waits for a kind on a v0.1 rule, and keeps its file", () => {
    const conversion = converted({ ruleKinds: {} });
    expect(conversion.rulesNeedingKind).toEqual([REFUNDS_RULE]);
    expect(conversion.records.map((r) => r.old_lineage)).not.toContain(REFUNDS_RULE);
    expect(conversion.cleanupPaths).not.toContain(
      ".oxagen/rules/ctx.a-intel.refunds-over-100.toml",
    );
  });

  it("takes a constraint's effect from the input when its file names none", () => {
    const path = ".oxagen/rules/ctx.a-intel.no-push-to-main.toml";
    const files = withFiles({
      [path]: (INPUT.get(path) as string).replace('constraint_effect = "forbid"\n', ""),
    });
    const waiting = converted({ files });
    expect(waiting.constraintsNeedingEffect).toEqual(["ctx.a-intel.no-push-to-main"]);

    const chosen = converted({
      files,
      constraintEffects: { "ctx.a-intel.no-push-to-main": "forbid" },
    });
    expect(written(chosen)).toEqual(EXPECTED);
  });
});

describe("convertOxagenTree: workspace.toml and governance", () => {
  it("opens no workspace.toml PR when the steering repo already lists the old repository", () => {
    const conversion = converted({ workspaceToml: EXPECTED.get("workspace.toml") });
    expect(conversion.branches.map((b) => b.branch)).toEqual([IMPORT_BRANCH]);
  });

  it("refuses a steering repo whose workspace.toml names another workspace", () => {
    // `billing` is a reserved slug, so a file naming it reads as unreadable
    // before the workspace comparison runs. `payments` is a legal slug.
    const other = (EXPECTED.get("workspace.toml") as string).replace(
      'workspace = "core-platform"',
      'workspace = "payments"',
    );
    expect(convertOxagenTree(input({ workspaceToml: other }))).toMatchObject({
      ok: false,
      reason: "workspace_mismatch",
    });
  });

  it("refuses a workspace.toml another tool owns", () => {
    expect(
      convertOxagenTree(input({ workspaceToml: 'schema = "oxagen-workspace/v0.1"\n' })),
    ).toMatchObject({ ok: false, reason: "workspace_toml_unreadable" });
  });

  it("refuses an old workspace.toml that names another workspace", () => {
    const files = withFiles({
      ".oxagen/workspace.toml": (INPUT.get(".oxagen/workspace.toml") as string).replace(
        'slug = "core-platform"',
        'slug = "payments"',
      ),
    });
    expect(convertOxagenTree(input({ files }))).toMatchObject({
      ok: false,
      reason: "workspace_mismatch",
    });
  });

  it("writes no governance.toml when the steering repo already has the mode", () => {
    const conversion = converted({ governanceToml: EXPECTED.get("steering/governance.toml") });
    expect(written(conversion).has("steering/governance.toml")).toBe(false);
  });

  it("carries the old mode, and reads a missing governance file as team", () => {
    const solo = withFiles({ ".oxagen/rules/governance.toml": 'mode = "solo"\n' });
    expect(written(converted({ files: solo })).get("steering/governance.toml")).toContain(
      'mode = "solo"',
    );
    const none = new Map([...INPUT].filter(([path]) => path !== ".oxagen/rules/governance.toml"));
    const conversion = converted({ files: none });
    expect(conversion.governanceMode).toBe("team");
    expect(written(conversion).get("steering/governance.toml")).toBe(
      EXPECTED.get("steering/governance.toml"),
    );
  });

  it("refuses an old governance file whose mode does not read", () => {
    const files = withFiles({ ".oxagen/rules/governance.toml": 'mode = "anarchy"\n' });
    expect(convertOxagenTree(input({ files }))).toMatchObject({
      ok: false,
      reason: "governance_unreadable",
      message: expect.stringContaining(".oxagen/rules/governance.toml"),
    });
  });
});

describe("convertOxagenTree: files the import leaves", () => {
  it("keeps machine-local files, removes an emptied keep file, and lists a file with no place", () => {
    const files = withFiles({
      ".oxagen/workspace.json": "{}\n",
      ".oxagen/rules/.gitkeep": "",
      ".oxagen/proposals/prp_01.json": "{}\n",
    });
    const conversion = converted({ files });
    expect(conversion.cleanupPaths).toContain(".oxagen/rules/.gitkeep");
    expect(conversion.cleanupPaths).not.toContain(".oxagen/workspace.json");
    expect(conversion.unconverted).toEqual([
      {
        path: ".oxagen/proposals/prp_01.json",
        reason: "the steering repo has no place for this file",
      },
    ]);
  });

  it("keeps a record without a valid record_id, because the stamp needs its old id", () => {
    const [badPath, badText] = legacyFact(1);
    const [missingPath, missingText] = legacyFact(2);
    const files = new Map([
      [badPath, badText.replace(/record_id = "[^"]+"/, 'record_id = "not-an-id"')],
      [missingPath, missingText.replace(/record_id = "[^"]+"\n/, "")],
    ]);
    const conversion = converted({ files });

    expect(conversion.records).toEqual([]);
    expect(conversion.cleanupPaths).not.toContain(badPath);
    expect(conversion.cleanupPaths).not.toContain(missingPath);
    expect(conversion.unconverted).toEqual([
      {
        path: badPath,
        lineage: "ctx.a-intel.fact-001",
        reason:
          'the record_id "not-an-id" is not a record id, so its runs cannot follow the record',
      },
      {
        path: missingPath,
        lineage: "ctx.a-intel.fact-002",
        reason: "the record_id null is not a record id, so its runs cannot follow the record",
      },
    ]);
    for (const batch of importBatches(conversion)) expect(replacesOf(batch)).toBeNull();
  });
});

describe("convertOxagenTree: import batches", () => {
  it("splits a large import into batches of at most the per-PR limit", () => {
    const conversion = converted({ files: legacyFacts(400) });
    const batches = importBatches(conversion);
    expect(batches.map((b) => b.branch)).toEqual([IMPORT_BRANCH, "steering/import-oxagen-2"]);
    expect(batches[0]!.files).toHaveLength(STEERING_PR_MAX_FILES);
    expect(batches[1]!.files).toHaveLength(400 - (STEERING_PR_MAX_FILES - 2) + 1);
    const seen = new Set<string>();
    for (const batch of batches) {
      expect(batch.files.length).toBeLessThanOrEqual(STEERING_PR_MAX_FILES);
      expect(branchScopeRefusal(batch.branch, batch.files.map((f) => f.path))).toBeNull();
      expect(replacesOf(batch)).toEqual(
        new Map(batch.records.map((record) => [record.to, record.old_id as string])),
      );
      for (const record of batch.records) {
        expect(seen.has(record.to)).toBe(false);
        seen.add(record.to);
        expect(batch.files.map((f) => f.path)).toContain(record.to);
      }
    }
    expect(seen.size).toBe(400);
  });

  it("keeps each skill's folder in one batch", () => {
    const files = withFiles(legacySkill("release-notes", 9), legacyFacts(290));
    const conversion = converted({ files });
    const batches = importBatches(conversion);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.files).toHaveLength(290 + 1 + 1);
    expect(batches[1]!.files.map((f) => f.path)).toEqual([
      "steering/skills/a-intel.core-platform.release-notes/SKILL.md",
      ...Array.from(
        { length: 9 },
        (_, i) =>
          `steering/skills/a-intel.core-platform.release-notes/ref-${String(i).padStart(3, "0")}.md`,
      ),
    ].sort());
    expect(replacesOf(batches[1]!)).toBeNull();
    expect(conversion.skills).toEqual([
      {
        from: ".oxagen/skills/release-notes/SKILL.md",
        to: "steering/skills/a-intel.core-platform.release-notes/SKILL.md",
        lineage: "a-intel.core-platform.release-notes",
      },
    ]);
  });

  it("refuses a skill whose folder alone is larger than one steering PR", () => {
    const files = withFiles(legacySkill("huge", STEERING_PR_MAX_FILES));
    expect(convertOxagenTree(input({ files }))).toMatchObject({
      ok: false,
      reason: "too_many_files",
      message: expect.stringContaining("steering/skills/a-intel.core-platform.huge/"),
    });
  });
});

describe("convertOxagenTree: agents", () => {
  it("writes an agent Oxagen holds whole, and lists the rest to place by hand", () => {
    const files = withFiles({ ".oxagen/agents/old-bot.toml": 'name = "old-bot"\n' });
    const conversion = converted({
      files,
      agents: [
        {
          slug: "release-bot",
          label: "Release bot",
          operator: "priya",
          runtime: "ci-linux-01",
          harness: "codex",
        },
        {
          slug: "ci-reviewer",
          label: "CI reviewer",
          operator: null,
          runtime: "ci-linux-01",
          harness: "codex",
        },
      ],
    });
    const agent = conversion.branches.find((b) => b.branch.startsWith("agents/"));
    expect(agent).toEqual({
      branch: "agents/a-intel.core-platform.release-bot",
      records: [],
      files: [
        {
          path: "agents/a-intel.core-platform.release-bot.toml",
          content: [
            "#:schema https://oxagen.sh/schemas/agent/v1.json",
            'schema = "agent/v1"',
            'name = "a-intel.core-platform.release-bot"',
            'label = "Release bot"',
            'operator = "priya"',
            'runtime = "ci-linux-01"',
            'harness = "codex"',
            "",
          ].join("\n"),
        },
      ],
    });
    expect(conversion.agentsByHand).toEqual([
      {
        name: "a-intel.core-platform.ci-reviewer",
        reason: "Oxagen holds no operator for the agent",
      },
      {
        name: "a-intel.core-platform.old-bot",
        reason: ".oxagen/agents/old-bot.toml is from before ADR-198, and Oxagen holds no agent with that slug",
      },
    ]);
    expect(conversion.cleanupPaths).toContain(".oxagen/agents/old-bot.toml");
  });
});

describe("importPullRequestBody", () => {
  it("lists the batch's records with their ids, and names the mode on the first batch", () => {
    const conversion = converted({ files: legacyFacts(400) });
    const [first, second] = importBatches(conversion);
    const body = importPullRequestBody(conversion, first!, RELINKED);
    expect(body).toContain("2 import batches");
    expect(body).toContain("through `steering/import-oxagen-2`");
    expect(body).toContain(IMPORT_REPLACES_PATH);
    expect(body).toContain(renderIdTable(first!.records));
    expect(body).toContain("## Governance");

    const next = importPullRequestBody(conversion, second!, RELINKED);
    expect(next).toContain(renderIdTable(second!.records));
    expect(next).not.toContain("## Governance");
  });

  it("lists what the import leaves for a person on its first PR only", () => {
    const files = withFiles({
      ".oxagen/proposals/prp_01.json": "{}\n",
      ".oxagen/agents/old-bot.toml": 'name = "old-bot"\n',
    });
    const conversion = converted({ files, ruleKinds: {} });
    const [first, ...rest] = conversion.branches;
    const body = importPullRequestBody(conversion, first!, RELINKED);
    expect(body).toContain("## Files to place by hand");
    expect(body).toContain(
      "- `.oxagen/proposals/prp_01.json`: the steering repo has no place for this file",
    );
    expect(body).toContain(
      `- \`${REFUNDS_RULE}\`: a person names the rule a business rule or a code rule`,
    );
    expect(body).toContain("## Agents to place by hand");
    expect(body).toContain(
      "- `a-intel.core-platform.old-bot`: .oxagen/agents/old-bot.toml is from before ADR-198",
    );
    expect(rest.length).toBeGreaterThan(0);
    for (const branch of rest) {
      expect(importPullRequestBody(conversion, branch, RELINKED)).not.toContain("to place by hand");
    }
  });

  it("names no files or agents to place by hand when the import converts everything", () => {
    const conversion = converted();
    expect(conversion.unconverted).toEqual([]);
    const body = importPullRequestBody(conversion, conversion.branches[0]!, RELINKED);
    expect(body).not.toContain("to place by hand");
  });

  it("carries no records section on the workspace.toml PR", () => {
    const conversion = converted();
    const workspace = conversion.branches.find((b) => b.branch === IMPORT_WORKSPACE_BRANCH);
    const body = importPullRequestBody(conversion, workspace!, RELINKED);
    expect(body).toContain("one import batch");
    expect(body).not.toContain("## Records");
  });
});
