// Each check's rules against small edits to the fixture repo. A test names
// the message, line, and field an agent reads, so a change to any of them
// shows up here.
import {
  countTokens,
  DEFAULT_ALWAYS_ON_TOKENS,
  DEFAULT_WORKSPACE_DEFINITION_BUDGET,
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  readManagedBlock,
  recordStatement,
  renderManagedBlock,
} from "@oxagen/oxagen/steering-repo";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { describe, expect, it } from "vitest";
import { alwaysOnBlocks, type AlwaysOnBlock } from "./always-on";
import { alwaysOnBudget, definitionBudget, directDefinitions } from "./checks/budget";
import { hasOperation } from "./checks/compile";
import { closest, importedTools } from "./checks/references";
import { formatCount, readRecordFile } from "./repo";
import { runChecks, STEERING_CHECK_NAMES } from "./run";
import { settingsDifferences } from "./settings-diff";
import { cedarStub, fixtureIndex, inputFor } from "./testing/support";
import type {
  CheckInput,
  CheckReport,
  CheckResult,
  Finding,
  IndexRecord,
  SettingsDifferenceInput,
  SteeringCheckName,
  SteeringTree,
} from "./types";

const PLAIN_WORDS = "steering/brand/a-intel.brand.plain-words.md";
const NO_PUSH = "steering/platform/a-intel.platform.no-push-to-main.md";
const VOICE = "steering/skills/a-intel.brand.voice/SKILL.md";
const GOVERNANCE = "steering/governance.toml";
const WORKSPACE = "workspace.toml";
const LEDGER = "steering/promotions/2026-09.jsonl";
const NEW_LEDGER = "steering/promotions/2026-10.jsonl";
const BILLING_SERVER = "tools/servers/billing/server.toml";
const BILLING_TOOLS = "tools/servers/billing/tools.toml";
const STRIPE_SERVER = "tools/servers/stripe/server.toml";
const STRIPE_TOOLS = "tools/servers/stripe/tools.toml";
const STRIPE_LOCK = "tools/servers/stripe/tools.lock.json";
const TOOLBELT = "tools/toolbelts/refunds.toml";
const AGENT = "agents/a-intel.core.ci-reviewer.toml";

const IMPORTED = [
  "billing__cancel_refund",
  "billing__create_refund",
  "billing__get_charge",
  "billing__get_refund",
  "billing__list_charges",
  "billing__list_refunds",
  "stripe__create_refund",
  "stripe__list_charges",
];

function textOf(path: string, tree: SteeringTree = fixtureRepo()): string {
  const text = tree.get(path);
  if (text === undefined) throw new Error(`The fixture has no ${path}.`);
  return text;
}

/** The tree with `from` swapped for `to` in one file. `from` must occur once. */
function replaced(path: string, from: string, to: string, tree: SteeringTree = fixtureRepo()): Map<string, string> {
  const text = textOf(path, tree);
  if (text.split(from).length !== 2) throw new Error(`${path} does not hold ${from} exactly once.`);
  return new Map(tree).set(
    path,
    text.replace(from, () => to),
  );
}

function withFile(path: string, text: string, tree: SteeringTree = fixtureRepo()): Map<string, string> {
  return new Map(tree).set(path, text);
}

function without(path: string, tree: SteeringTree = fixtureRepo()): Map<string, string> {
  const next = new Map(tree);
  if (!next.delete(path)) throw new Error(`The tree has no ${path}.`);
  return next;
}

/** The 1-based line that reads `line` exactly. */
function lineOf(text: string, line: string): number {
  const index = text.split("\n").indexOf(line);
  if (index < 0) throw new Error(`No line reads ${line}.`);
  return index + 1;
}

function run(files: SteeringTree, check: SteeringCheckName, overrides: Partial<CheckInput> = {}): CheckReport {
  return runChecks(inputFor(files, { checks: [check], ...overrides }));
}

function resultOf(report: CheckReport, check: SteeringCheckName): CheckResult {
  const found = report.results.find((result) => result.check === check);
  if (found === undefined) throw new Error(`The report has no ${check} result.`);
  return found;
}

function findingsOf(report: CheckReport, check: SteeringCheckName, rule?: string): Finding[] {
  return report.findings.filter((finding) => finding.check === check && (rule === undefined || finding.rule === rule));
}

/** Path, line, and message: what most tests compare. */
function placed(findings: readonly Finding[]): [string, number | null, string][] {
  return findings.map((finding) => [finding.path, finding.line, finding.message]);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A copy of `settings` with the dotted `path` set to `value`, or removed when `value` is undefined. */
function withSetting(settings: unknown, path: string, value: unknown): Record<string, unknown> {
  const copy = clone(settings) as Record<string, unknown>;
  const keys = path.split(".");
  let node = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

function repositoryName(block: AlwaysOnBlock): string {
  return block.repository ?? "a repository no record names";
}

describe("runChecks", () => {
  it("reports each check the run did not select as skipped, in the spec's order", () => {
    const report = runChecks(inputFor(fixtureRepo(), { checks: ["schema", "owned"] }));
    expect(report.results.map((result) => result.check)).toEqual([...STEERING_CHECK_NAMES]);
    for (const result of report.results) {
      if (result.check === "schema" || result.check === "owned") continue;
      expect(result).toEqual({
        check: result.check,
        status: "skipped",
        summary: "Skipped: this run did not select it.",
        findings: [],
      });
    }
    expect(report.passed).toBe(true);
  });

  it("turns a check that throws into one internal error", () => {
    const cedar = {
      ...cedarStub,
      parse: () => {
        throw new Error("the evaluator crashed");
      },
    };
    const report = runChecks(inputFor(fixtureRepo(), { base: null, cedar, checks: ["compile"] }));
    expect(report.findings).toEqual([
      {
        check: "compile",
        rule: "internal",
        severity: "error",
        path: "",
        line: null,
        field: null,
        message: "The compile check stopped before it finished: the evaluator crashed",
        expected: "The compile check reads every file and reports what it finds.",
        fix: "Run the checks again. If this check stops again, report it to Oxagen with a link to the steering PR.",
      },
    ]);
    expect(resultOf(report, "compile")).toMatchObject({ status: "failed", summary: "1 error." });
    expect(report.passed).toBe(false);
  });

  it("says so when no Cedar evaluator was passed in", () => {
    const input = inputFor(fixtureRepo(), { checks: ["compile"] });
    delete input.cedar;
    expect(resultOf(runChecks(input), "compile")).toEqual({
      check: "compile",
      status: "passed",
      summary: "No findings. Oxagen did not evaluate the Cedar policies, because no Cedar evaluator was passed in.",
      findings: [],
    });
  });

  it("leaves out a finding the base already has in a file the steering PR does not change", () => {
    const ghost = [
      "#:schema https://oxagen.sh/schemas/toolbelt/v1.json",
      'schema = "toolbelt/v1"',
      'name = "ghost"',
      "tools = [",
      '  "ghost__x",',
      "]",
      "",
    ].join("\n");
    const base = withFile("tools/toolbelts/ghost.toml", ghost);
    const head = withFile("notes/a.md", "A note.\n", base);
    expect(findingsOf(run(head, "references", { base }), "references", "tool-exists")).toEqual([]);
    const whole = findingsOf(run(head, "references", { base: null }), "references", "tool-exists");
    expect(whole.map((finding) => [finding.path, finding.line, finding.field])).toEqual([
      ["tools/toolbelts/ghost.toml", 5, "tools.0"],
    ]);
  });
});

describe("settings", () => {
  it("skips when no repository settings were passed in", () => {
    expect(resultOf(run(fixtureRepo(), "settings", { health: null }), "settings")).toEqual({
      check: "settings",
      status: "skipped",
      summary: "Skipped: no repository settings were passed in, as when the check runs on a laptop.",
      findings: [],
    });
  });

  it("finds no difference in either baseline", () => {
    expect(settingsDifferences("github", clone(GITHUB_SETTINGS_BASELINE))).toEqual([]);
    expect(settingsDifferences("gitlab", clone(GITLAB_SETTINGS_BASELINE))).toEqual([]);
  });

  it("names a deleted ruleset by the name GitHub shows", () => {
    const differences = settingsDifferences(
      "github",
      withSetting(GITHUB_SETTINGS_BASELINE, "rulesets.oxagen_merges", undefined),
    );
    expect(differences.map((difference) => [difference.setting, difference.actual])).toEqual([
      ["rulesets.oxagen_merges", null],
    ]);
    const report = run(fixtureRepo(), "settings", { health: { differences } });
    expect(findingsOf(report, "settings").map((finding) => [finding.rule, finding.path, finding.message])).toEqual([
      ["ruleset-deleted", "rulesets.oxagen_merges", 'The ruleset "Oxagen merges" was deleted.'],
    ]);
    expect(resultOf(report, "settings")).toMatchObject({
      status: "failed",
      summary: "1 error. Repository settings changed. Oxagen will not merge or publish until they match.",
    });
  });

  it("describes each GitHub setting that turns off a protection", () => {
    const actual = withSetting(
      withSetting(GITHUB_SETTINGS_BASELINE, "rulesets.oxagen_steering.rules", []),
      "actions.enabled",
      true,
    );
    const differences: SettingsDifferenceInput[] = [
      ...settingsDifferences("github", actual),
      { setting: "rulesets.custom", expected: { name: "custom" }, actual: null },
    ];
    const findings = findingsOf(run(fixtureRepo(), "settings", { health: { differences } }), "settings");
    expect(findings.map((finding) => [finding.rule, finding.path, finding.message])).toEqual([
      ["actions-enabled", "actions.enabled", "GitHub Actions is on."],
      ["ruleset-deleted", "rulesets.custom", 'The ruleset "custom" was deleted.'],
      [
        "required-check-removed",
        "rulesets.oxagen_steering.rules",
        'The ruleset "Oxagen steering" no longer requires the check "Oxagen steering".',
      ],
    ]);
  });

  it("describes each GitLab setting that turns off a protection", () => {
    let actual = withSetting(GITLAB_SETTINGS_BASELINE, "ci_cd.builds_access_level", "enabled");
    actual = withSetting(actual, "merge_requests.required_status", "x");
    actual = withSetting(actual, "protected_branches.main.allow_force_push", true);
    const differences = settingsDifferences("gitlab", actual);
    const findings = findingsOf(run(fixtureRepo(), "settings", { health: { differences } }), "settings");
    expect(findings.map((finding) => [finding.rule, finding.message])).toEqual([
      ["ci-enabled", "CI/CD is on."],
      ["required-check-removed", 'Merge requests no longer require the status "Oxagen steering".'],
      ["force-push-allowed", "The protected branch main allows force pushes."],
    ]);
  });

  it("names who changed a setting and when, as far as the host reports it", () => {
    const long = "a".repeat(200);
    const differences: SettingsDifferenceInput[] = [
      {
        setting: "visibility",
        expected: "private",
        actual: "public",
        changed_by: "dana",
        changed_at: "2026-09-26T05:00:00Z",
      },
      { setting: "default_branch", expected: "main", actual: "trunk", changed_by: null, changed_at: "2026-09-26T05:00:00Z" },
      { setting: "merge.allow_merge_commit", expected: false, actual: true, changed_by: "priya", changed_at: null },
      { setting: "merge.allow_rebase_merge", expected: false, actual: true },
      { setting: "x", expected: null, actual: long },
    ];
    const findings = findingsOf(run(fixtureRepo(), "settings", { health: { differences } }), "settings");
    expect(findings.map((finding) => [finding.rule, finding.message, finding.expected])).toEqual([
      ["setting-differs", 'default_branch is "trunk" (2026-09-26T05:00:00Z).', 'default_branch is "main".'],
      ["setting-differs", "merge.allow_merge_commit is true (by @priya).", "merge.allow_merge_commit is false."],
      ["setting-differs", "merge.allow_rebase_merge is true.", "merge.allow_rebase_merge is false."],
      [
        "setting-differs",
        'visibility is "public" (2026-09-26T05:00:00Z, by @dana).',
        'visibility is "private".',
      ],
      ["setting-differs", `x is ${JSON.stringify(long).slice(0, 117)}....`, "x is unset."],
    ]);
  });
});

describe("budget", () => {
  it("reads each budget from its file, or uses Oxagen's default", () => {
    const defaultAlwaysOn = { tokens: DEFAULT_ALWAYS_ON_TOKENS, source: "Oxagen's default" };
    expect(alwaysOnBudget(null)).toEqual(defaultAlwaysOn);
    expect(alwaysOnBudget(fixtureRepo())).toEqual({ tokens: 4000, source: "governance.toml" });
    expect(alwaysOnBudget(replaced(GOVERNANCE, "always_on_tokens = 4000", 'always_on_tokens = "off"'))).toBe("off");
    expect(alwaysOnBudget(replaced(GOVERNANCE, "always_on_tokens = 4000", "always_on_tokens = 0"))).toEqual(
      defaultAlwaysOn,
    );
    expect(definitionBudget(null)).toEqual({
      tokens: DEFAULT_WORKSPACE_DEFINITION_BUDGET,
      source: "Oxagen's default",
    });
    expect(definitionBudget(fixtureRepo())).toEqual({ tokens: 20000, source: "workspace.toml" });
  });

  it("skips the always-on comparison when governance.toml turns it off", () => {
    const head = replaced(GOVERNANCE, "always_on_tokens = 4000", 'always_on_tokens = "off"');
    expect(resultOf(run(head, "budget"), "budget")).toEqual({
      check: "budget",
      status: "passed",
      summary: "No findings. governance.toml turns the always-on budget off.",
      findings: [],
    });
  });

  it("warns for each code repository over a lowered budget and names its largest records", () => {
    const report = run(replaced(GOVERNANCE, "always_on_tokens = 4000", "always_on_tokens = 1"), "budget");
    const blocks = alwaysOnBlocks(fixtureRepo());
    const over = blocks.filter((block) => block.tokens > 1);
    expect(over.length).toBeGreaterThan(0);
    const findings = findingsOf(report, "budget", "always-on");
    expect(findings.map((finding) => finding.message)).toEqual(
      over.map(
        (block) =>
          `Always-on steering for ${repositoryName(block)} is ${formatCount(block.tokens)} tokens, over the budget of 1. It was ${formatCount(block.tokens)} before this steering PR.`,
      ),
    );
    for (const finding of findings) {
      expect(finding).toMatchObject({
        severity: "warning",
        path: GOVERNANCE,
        line: 6,
        field: "steering.always_on_tokens",
        expected: "At most 1 tokens of always-on steering per code repository, from governance.toml.",
      });
    }
    const first = over[0] as AlwaysOnBlock;
    const largest = [...first.entries]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((entry) => `${entry.lineage} (${formatCount(entry.tokens)} tokens)`)
      .join(", ");
    expect(findings[0]?.fix).toBe(
      `To keep this cost, merge as is, or raise always_on_tokens in this PR. To cut it, shorten a record, set force: may so it loads when it fits, or narrow it with repos, applies_to, or tools. The largest records are ${largest}.`,
    );
    const notes = blocks
      .map((block) => `${repositoryName(block)}: ${formatCount(block.tokens)} to ${formatCount(block.tokens)} always-on tokens.`)
      .join(" ");
    const count = over.length === 1 ? "1 warning." : `${over.length} warnings.`;
    expect(resultOf(report, "budget")).toMatchObject({ status: "warned", summary: `${count} ${notes}` });
  });

  it("names the tokens of each changed record", () => {
    const head = replaced(PLAIN_WORDS, "Write product copy in short sentences", "Write product copy in short, clear sentences");
    const file = readRecordFile(PLAIN_WORDS, textOf(PLAIN_WORDS, head));
    expect(file).not.toBeNull();
    const tail = `Changed records: a-intel.brand.plain-words is ${formatCount(countTokens(recordStatement(file?.body ?? "")))} tokens.`;
    const summary = resultOf(run(head, "budget"), "budget").summary;
    expect(summary.slice(-tail.length)).toBe(tail);
  });

  it("warns when direct-mode tool definitions pass the workspace budget", () => {
    const servers = directDefinitions(fixtureRepo());
    const total = servers.reduce((sum, server) => sum + server.tokens, 0);
    expect(total).toBeGreaterThan(1);
    const named = servers
      .slice(0, 3)
      .map((server) => `${server.server} (${formatCount(server.tokens)} tokens)`)
      .join(", ");
    const report = run(replaced(WORKSPACE, "definition_budget = 20000", "definition_budget = 1"), "budget");
    expect(findingsOf(report, "budget")).toEqual([
      expect.objectContaining({
        rule: "tool-definitions",
        severity: "warning",
        path: WORKSPACE,
        line: 19,
        field: "tools.definition_budget",
        message: `Direct-mode tool definitions cost ${formatCount(total)} tokens on every request, over the budget of 1. They cost ${formatCount(total)} before this steering PR.`,
        expected: "At most 1 tokens of direct-mode definitions, from workspace.toml.",
        fix: `Move the largest servers to search mode with mode = "search" under [exposure] in their server.toml: ${named}. Or raise definition_budget under [tools] in workspace.toml.`,
      }),
    ]);
    expect(resultOf(report, "budget").summary).toBe(
      `1 warning. Direct-mode tool definitions: ${formatCount(total)} to ${formatCount(total)} tokens.`,
    );
  });

  it("counts only the servers in direct mode", () => {
    const before = directDefinitions(fixtureRepo());
    expect(before.map((server) => server.server).sort()).toEqual(["billing", "stripe"]);
    const head = replaced(STRIPE_SERVER, '[exposure]\nmode = "direct"', '[exposure]\nmode = "search"');
    const after = directDefinitions(head);
    expect(after.map((server) => server.server)).toEqual(["billing"]);
    const sum = (servers: typeof before) => servers.reduce((total, server) => total + server.tokens, 0);
    expect(resultOf(run(head, "budget"), "budget")).toMatchObject({
      status: "passed",
      summary: `No findings. Direct-mode tool definitions: ${formatCount(sum(before))} to ${formatCount(sum(after))} tokens.`,
    });
  });
});

describe("owned", () => {
  it("reads only the managed blocks when there is no production branch", () => {
    expect(resultOf(run(fixtureRepo(), "owned", { base: null }), "owned")).toEqual({
      check: "owned",
      status: "passed",
      summary: "No findings. With no production branch to compare, only the managed blocks were read.",
      findings: [],
    });
  });

  it("fails a file only Oxagen writes, whether the steering PR changes, adds, or removes it", () => {
    const ledger = textOf(LEDGER);
    let head = withFile(LEDGER, `${ledger}{}\n`);
    head = withFile(NEW_LEDGER, "{}\n", head);
    head = without(STRIPE_LOCK, head);
    const findings = findingsOf(run(head, "owned"), "owned", "oxagen-writes");
    const holds = "It holds the promotion ledger, which Oxagen writes when it stamps a merged steering PR.";
    expect(placed(findings)).toEqual([
      [LEDGER, ledger.split("\n").length, `This steering PR changes ${LEDGER}. ${holds}`],
      [NEW_LEDGER, 1, `This steering PR adds ${NEW_LEDGER}. ${holds}`],
      [
        STRIPE_LOCK,
        null,
        `This steering PR removes ${STRIPE_LOCK}. It holds a server's reviewed upstream definitions, which Oxagen writes when it syncs the server.`,
      ],
    ]);
    expect(findings[2]).toMatchObject({
      expected: `${STRIPE_LOCK} as the production branch holds it.`,
      fix: `Restore ${STRIPE_LOCK} from the production branch. Make the change in the files Oxagen compiles it from, and Oxagen rewrites it.`,
    });
  });

  it("fails a second block, a rewritten block, and a removed file", () => {
    const agents = textOf("AGENTS.md");
    let head = withFile("AGENTS.md", `${agents}${renderManagedBlock("x")}`);
    head = withFile("CLAUDE.md", renderManagedBlock("@AGENTS.md\nMore notes.\n"), head);
    head = without("README.md", head);
    expect(placed(findingsOf(run(head, "owned"), "owned", "managed-block"))).toEqual([
      ["AGENTS.md", agents.split("\n").length, "AGENTS.md: The file holds a second managed block."],
      ["CLAUDE.md", 1, "This steering PR rewrites the managed block in CLAUDE.md."],
      ["README.md", null, "This steering PR removes README.md and the managed block Oxagen writes in it."],
    ]);
  });

  it("fails a block edited by hand, and a block taken out of its file", () => {
    const edited = replaced("CLAUDE.md", "@AGENTS.md\n", "@AGENTS.md and more\n");
    const read = readManagedBlock(textOf("CLAUDE.md", edited));
    if (!read.ok || read.block === null) throw new Error("The edited CLAUDE.md has no managed block.");
    expect(read.block.actual_hash).not.toBe(read.block.declared_hash);
    expect(placed(findingsOf(run(edited, "owned"), "owned"))).toEqual([
      [
        "CLAUDE.md",
        read.block.begin_line,
        `The managed block in CLAUDE.md was edited. Its text hashes to ${read.block.actual_hash}, and its begin marker says ${read.block.declared_hash}.`,
      ],
    ]);
    expect(placed(findingsOf(run(withFile("CLAUDE.md", "@AGENTS.md\n"), "owned"), "owned"))).toEqual([
      ["CLAUDE.md", 1, "This steering PR removes the managed block from CLAUDE.md."],
    ]);
  });
});

describe("schema", () => {
  it("reports a server file TOML cannot parse", () => {
    const findings = findingsOf(run(replaced(STRIPE_SERVER, "[exposure]\n", "[exposure\n"), "schema"), "schema", "toml-syntax");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: STRIPE_SERVER,
      expected: "A file TOML can parse.",
      fix: "Correct the syntax on this line.",
    });
    expect(findings[0]?.message).toMatch(/^The file is not TOML: /);
  });

  it("reports CRLF line endings in a server file", () => {
    const crlf = textOf(STRIPE_SERVER).split("\n").join("\r\n");
    const findings = findingsOf(run(withFile(STRIPE_SERVER, crlf), "schema"), "schema");
    expect(findings.map((finding) => [finding.rule, finding.path, finding.line, finding.message])).toEqual([
      ["encoding", STRIPE_SERVER, 1, "The file has CRLF line endings. Use LF."],
    ]);
  });

  it("reads server files with the readers passed in", () => {
    const issue = {
      line: 24,
      field: "exposure.mode",
      message: "Invalid enum value. Expected 'direct' | 'search', received 'x'",
    };
    const servers = {
      server: () => ({ ok: false as const, issues: [issue] }),
      tools: () => ({ ok: true as const }),
    };
    const findings = findingsOf(run(fixtureRepo(), "schema", { base: null, servers }), "schema", "enum-value");
    expect(findings.map((finding) => finding.path)).toEqual([BILLING_SERVER, STRIPE_SERVER]);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        line: 24,
        field: "exposure.mode",
        message: "exposure.mode: Invalid enum value. Expected 'direct' | 'search', received 'x'.",
        expected: "One of 'direct' | 'search'.",
        fix: "Use one of the values the schema lists.",
      });
    }
  });

  it("warns when one folder holds more than 800 files", () => {
    const withNotes = (count: number) => {
      const tree = fixtureRepo();
      for (let n = 0; n < count; n += 1) tree.set(`notes/n${n}.md`, "A note.\n");
      return tree;
    };
    expect(findingsOf(run(withNotes(801), "schema"), "schema", "folder-files")).toEqual([
      expect.objectContaining({
        severity: "warning",
        path: "notes",
        line: null,
        field: null,
        message: "The folder holds more than 800 files.",
        detail: { files: 801 },
      }),
    ]);
    expect(findingsOf(run(withNotes(800), "schema"), "schema", "folder-files")).toEqual([]);
  });

  it("names a toolbelt or an agent file for the name it declares", () => {
    const belt = withFile("tools/toolbelts/refund-tools.toml", textOf(TOOLBELT), without(TOOLBELT));
    expect(findingsOf(run(belt, "schema"), "schema", "file-named-for-name")).toEqual([
      expect.objectContaining({
        path: "tools/toolbelts/refund-tools.toml",
        line: 3,
        field: "name",
        message: "The file is named refund-tools, but its name is refunds.",
        fix: 'Rename the file to refunds.toml, or set name = "refund-tools".',
      }),
    ]);
    const agent = withFile("agents/ci-reviewer.toml", textOf(AGENT), without(AGENT));
    expect(placed(findingsOf(run(agent, "schema"), "schema", "file-named-for-name"))).toEqual([
      ["agents/ci-reviewer.toml", 3, "The file is named ci-reviewer, but its name is a-intel.core.ci-reviewer."],
    ]);
  });

  it("keeps a skill in its own folder, and only a skill there", () => {
    const asSkill = replaced(PLAIN_WORDS, "kind: preference\n", "kind: skill\n");
    expect(placed(findingsOf(run(asSkill, "schema"), "schema", "skill-shape"))).toEqual([
      [PLAIN_WORDS, 6, "A skill must live in its own folder under steering/skills."],
    ]);
    const notSkill = replaced(VOICE, "kind: skill\n", "kind: preference\n");
    expect(placed(findingsOf(run(notSkill, "schema"), "schema", "skill-shape"))).toEqual([
      [VOICE, 5, "A SKILL.md must have kind: skill, but this one has kind: preference."],
    ]);
  });

  it("reports an empty body and a missing opening fence", () => {
    const text = textOf(PLAIN_WORDS);
    const frontmatter = text.slice(0, text.indexOf("\n---\n", 3) + 5);
    const empty = findingsOf(run(withFile(PLAIN_WORDS, frontmatter), "schema"), "schema", "body-required");
    expect(empty.map((finding) => [finding.path, finding.message])).toEqual([
      [PLAIN_WORDS, "The body is empty. Write the statement below the frontmatter."],
    ]);
    const unfenced = findingsOf(run(withFile(PLAIN_WORDS, text.slice(4)), "schema"), "schema", "record-fences");
    expect(placed(unfenced)).toEqual([[PLAIN_WORDS, 1, "A record starts with --- on its own line."]]);
  });
});

describe("references", () => {
  it("resolves an agent's operator against members and teams", () => {
    const nobody = replaced(AGENT, 'operator = "platform-team"', 'operator = "nobody"');
    expect(placed(findingsOf(run(nobody, "references"), "references", "operator-exists"))).toEqual([
      [AGENT, 5, "No member or team named nobody exists in Oxagen."],
    ]);
    const typo = replaced(AGENT, 'operator = "platform-team"', 'operator = "platfrm-team"');
    expect(placed(findingsOf(run(typo, "references"), "references", "operator-exists"))).toEqual([
      [AGENT, 5, "No member or team named platfrm-team exists in Oxagen. Did you mean platform-team?"],
    ]);
  });

  it("resolves an agent's runtime against the enrolled runtimes", () => {
    const head = replaced(AGENT, 'runtime = "ci-linux-01"', 'runtime = "ci-linux-02"');
    expect(findingsOf(run(head, "references"), "references", "runtime-enrolled")).toEqual([
      expect.objectContaining({
        path: AGENT,
        line: 6,
        field: "runtime",
        message: "No runtime named ci-linux-02 is enrolled in Oxagen. Did you mean ci-linux-01?",
      }),
    ]);
  });

  it("resolves a toolbelt's tools against the imported tools", () => {
    const typo = replaced(TOOLBELT, '"stripe__list_charges",', '"stripe__list_charge",');
    expect(findingsOf(run(typo, "references"), "references", "tool-exists")).toEqual([
      expect.objectContaining({
        path: TOOLBELT,
        line: 7,
        field: "tools.0",
        message: "stripe__list_charge names a tool no server in the workspace imports. Did you mean stripe__list_charges?",
        fix: "Correct the name, or import the tool in tools/servers/stripe/tools.toml.",
      }),
    ]);
    const ghost = replaced(TOOLBELT, '"stripe__list_charges",', '"ghost__x",');
    expect(findingsOf(run(ghost, "references"), "references", "tool-exists")).toEqual([
      expect.objectContaining({
        path: TOOLBELT,
        line: 7,
        message: "ghost__x names a tool no server in the workspace imports.",
        fix: "Correct the name, or add the server ghost under tools/servers/.",
      }),
    ]);
  });

  it("suggests the closest name only when it is close enough to be a typo", () => {
    expect(closest("platfrm-team", ["dana", "platform-team"])).toBe("platform-team");
    expect(closest("nobody", ["dana", "priya", "platform-team"])).toBeNull();
    expect(closest("x", [])).toBeNull();
  });

  it("lists each imported tool from tools.toml, or from the lock without one", () => {
    const imported = importedTools(fixtureRepo());
    expect(imported.tools).toEqual(IMPORTED);
    expect([...imported.servers].sort()).toEqual(["billing", "stripe"]);
    expect(importedTools(without(STRIPE_TOOLS)).tools).toEqual(IMPORTED);
  });
});

describe("compile", () => {
  it("finds an operationId in YAML or JSON", () => {
    expect(hasOperation("paths:\n  /charges:\n    get:\n      operationId: listCharges\n", "listCharges")).toBe(true);
    expect(hasOperation("      operationId: 'listCharges'\n", "listCharges")).toBe(true);
    expect(hasOperation('{"operationId": "listCharges"}', "listCharges")).toBe(true);
    expect(hasOperation("      operationId: listCharges\n", "listCharge")).toBe(false);
    expect(hasOperation("operationId: axb\n", "a.b")).toBe(false);
  });

  it("accepts a tool whose operation the OpenAPI document holds", () => {
    const head = withFile(BILLING_TOOLS, `${textOf(BILLING_TOOLS)}\n[tools.cancel_again]\noperation = "cancelRefund"\n`);
    expect(findingsOf(run(head, "compile"), "compile", "lock-matches")).toEqual([]);
  });

  it("fails a tool that neither the lock nor the OpenAPI document holds", () => {
    const billing = `${textOf(BILLING_TOOLS)}\n[tools.void_charge]\noperation = "voidCharge"\n`;
    const stripe = `${textOf(STRIPE_TOOLS)}\n[tools.refund_all]\nrisk = "low"\n`;
    const head = withFile(STRIPE_TOOLS, stripe, withFile(BILLING_TOOLS, billing));
    const findings = findingsOf(run(head, "compile"), "compile", "lock-matches");
    expect(findings.map((finding) => [finding.path, finding.line, finding.field, finding.message])).toEqual([
      [
        BILLING_TOOLS,
        lineOf(billing, "[tools.void_charge]"),
        "tools.void_charge",
        "tools.toml imports billing__void_charge as operation voidCharge, and the lock or the OpenAPI document does not hold it.",
      ],
      [
        STRIPE_TOOLS,
        lineOf(stripe, "[tools.refund_all]"),
        "tools.refund_all",
        "tools.toml imports stripe__refund_all, and the lock does not hold it.",
      ],
    ]);
  });
});

describe("conflicts", () => {
  it("finds a record that says what a published record already says", () => {
    const file = readRecordFile(PLAIN_WORDS, textOf(PLAIN_WORDS));
    if (file === null) throw new Error("The fixture's plain-words record does not read.");
    const copyRules: IndexRecord = {
      lineage: "a-intel.brand.copy-rules",
      path: "steering/brand/a-intel.brand.copy-rules.md",
      id: "rec_a_intel_brand_copy_rules_000000000000",
      hash: `sha256:${"0".repeat(64)}`,
      kind: "preference",
      effect: null,
      statement: recordStatement(file.body),
    };
    const index = { records: [...(fixtureIndex()?.records ?? []), copyRules] };
    const findings = findingsOf(run(fixtureRepo(), "conflicts", { base: null, index }), "conflicts", "near-duplicate");
    expect(placed(findings)).toEqual([
      [PLAIN_WORDS, file.body_line, "This record says what the published record a-intel.brand.copy-rules already says."],
    ]);
  });

  it("fails a published constraint the steering PR flips, from the index or the base", () => {
    const head = replaced(NO_PUSH, "effect: forbid\n", "effect: require\n");
    const message =
      "The published constraint a-intel.platform.no-push-to-main is a forbid, and this change makes it a require.";
    const fromIndex = findingsOf(run(head, "conflicts", { base: null }), "conflicts", "effect-flip");
    expect(fromIndex.map((finding) => [finding.path, finding.line, finding.field, finding.message])).toEqual([
      [NO_PUSH, 7, "effect", message],
    ]);
    const fromBase = findingsOf(run(head, "conflicts", { index: null }), "conflicts", "effect-flip");
    expect(fromBase).toEqual([expect.objectContaining({ path: NO_PUSH, message, expected: "effect: forbid, as published." })]);
  });
});

describe("secrets", () => {
  it("finds personal data on the line that holds it", () => {
    const head = withFile(
      "notes/a.md",
      "Call the billing lead.\nTheir number is 123-45-6789.\nThe test card is 4111 1111 1111 1111.\n",
    );
    expect(placed(findingsOf(run(head, "secrets"), "secrets", "personal-data"))).toEqual([
      ["notes/a.md", 2, "The file holds what looks like a US social security number."],
      ["notes/a.md", 3, "The file holds what looks like a payment card number."],
    ]);
  });

  it("finds a private key block", () => {
    const head = withFile("notes/key.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    expect(placed(findingsOf(run(head, "secrets"), "secrets", "credential"))).toEqual([
      ["notes/key.pem", 1, "The file holds a private key block."],
    ]);
  });

  it("skips the files only Oxagen writes", () => {
    const line = '{"by":"dana@example.com"}\n';
    const head = withFile("notes/b.md", line, withFile(NEW_LEDGER, line));
    expect(placed(findingsOf(run(head, "secrets"), "secrets"))).toEqual([
      ["notes/b.md", 1, "The file holds what looks like an email address."],
    ]);
  });
});
