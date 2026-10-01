// The fixture cases lane S0 wrote: each invalid case must fail with the
// finding its case.json names, and a steering PR that changes one valid
// record must pass.
import {
  agentSchema,
  classifySteeringRepoPath,
  governanceSchema,
  readSteeringRecord,
  readTomlFile,
  toolbeltSchema,
  workspaceSchema,
  type FileIssue,
} from "@oxagen/oxagen/steering-repo";
import {
  FIXTURE_CHECKS,
  fixtureRepo,
  invalidCases,
  type InvalidCase,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { describe, expect, it } from "vitest";
import { alwaysOnBlocks } from "./always-on";
import { sentence } from "./finding";
import { runChecks, STEERING_CHECK_NAMES } from "./run";
import { settingsDifferences } from "./settings-diff";
import { fixtureBundle, inputFor } from "./testing/support";
import type { CheckInput, CheckReport, Finding } from "./types";

const CREDENTIAL =
  /^The file (holds a private key block|holds a token that looks like a credential|sets \S+ to a value that looks like a secret)\.$/;

/** The message each case's finding carries, for every case the S0 readers do not refuse on their own. */
const MESSAGES: Readonly<Record<string, RegExp | string>> = {
  "authority/effect-on-constraint-only": /^Only a constraint takes an effect, and this record is a \S+\.$/,
  "authority/no-allow": "A record cannot allow anything. Only a person or a Cedar policy grants authority.",
  "budget/always-on":
    /^Always-on steering for .+ is [\d,]+ tokens, over the budget of [\d,]+\. It was [\d,]+ before this steering PR\.$/,
  "budget/tool-definitions":
    /^Direct-mode tool definitions cost [\d,]+ tokens on every request, over the budget of [\d,]+\. They cost [\d,]+ before this steering PR\.$/,
  "compile/lock-matches":
    /^tools\.toml imports billing__\S+( as operation \S+)?, and the lock( or the OpenAPI document)? does not hold it\.$/,
  "compile/policy-parses": /^The policy does not parse: /,
  "compile/policy-test-passes": /expects allow, and the policies decide require_approval\.$/,
  "compile/policy-validates": "The action billing__void_invoice is not in the schema.",
  "conflicts/near-duplicate": /^This record says what .+ already says\.$/,
  "conflicts/opposite-constraint":
    /^This constraint's effect is (require|forbid), and .+ is a (require|forbid) constraint on the same statement\. Both cannot hold\.$/,
  "hash/stale-stamp": "The record changed, but its id and hash still name the published version.",
  "hash/typed-stamp": "The record carries an id and hash that Oxagen did not write for this content.",
  "lineage/unique": /^The lineage a-intel\.platform\.no-push-to-main is also declared in .+\.$/,
  "owned/agents-md-edited":
    /^The managed block in AGENTS\.md was edited\. Its text hashes to \S+, and its begin marker says \S+\.$/,
  "owned/cedar-schema-edited": /^This steering PR changes policy\/schema\.cedarschema\. It holds the Cedar schema/,
  "owned/claude-md-removed": "This steering PR removes the managed block from CLAUDE.md.",
  "owned/ledger-edited": /^This steering PR changes steering\/promotions\/2026-09\.jsonl\. It holds the promotion ledger/,
  "owned/lock-edited": /^This steering PR changes tools\/servers\/stripe\/tools\.lock\.json\. It holds a server's reviewed/,
  "references/credential-exists": /^The vault holds no credential named \S+\./,
  "references/group-exists": /^No reviewer group named \S+ exists in Oxagen\./,
  "references/record-mention": /^The body mentions @record:\S+, and /,
  "references/repository-linked": /^The record names \S+, and workspace\.toml does not link it\.$/,
  "references/runtime-enrolled": /^No runtime named \S+ is enrolled in Oxagen\./,
  "references/skill-exists": /^The record names the skill \S+, and no active skill has that lineage\./,
  "references/skill-file-exists": /^The skill names @\S+, and \S+ does not exist\.$/,
  "references/skill-mention": /^The body mentions @skill:\S+, and /,
  "references/tool-exists": /^\S+ names a tool no server in the workspace imports\./,
  "references/tool-mention": /^The body mentions @tool:\S+, and /,
  "schema/always-on-words": "The always-on statement is longer than 120 words.",
  "schema/file-named-for-lineage": /^The file is named a-intel\.platform\.wrong-name\.md, but its lineage is \S+\.$/,
  "schema/skill-folder-named-for-lineage": /^The skill's folder is named code-reviewer, but its lineage is \S+\.$/,
  "schema/skill-lines": "The SKILL.md is longer than 500 lines.",
  "secrets/password-in-asset": CREDENTIAL,
  "secrets/personal-data": "The file holds what looks like an email address.",
  "secrets/token-in-record": CREDENTIAL,
  "settings/actions-enabled": /^GitHub Actions is on/,
  "settings/force-push-allowed": /^The protected branch main allows force pushes/,
  "settings/required-check-removed": /^Merge requests no longer require the status "/,
  "settings/merge-commit-enabled": "merge.allow_merge_commit is true.",
};

/**
 * Lines where a case.json points somewhere other than its file. The
 * typed-stamp case names line 5, its description. The id it expects is on
 * line 14.
 */
const LINE_ERRATA: Readonly<Record<string, number>> = { "hash/typed-stamp": 14 };

/** What the S0 reader says about a file it refuses, as the schema check reports it. */
function readerIssues(path: string, text: string): readonly FileIssue[] {
  switch (classifySteeringRepoPath(path)) {
    case "record":
    case "skill-record": {
      const read = readSteeringRecord(text);
      return read.ok ? [] : read.issues;
    }
    case "workspace": {
      const read = readTomlFile(text, "workspace/v1", workspaceSchema);
      return read.ok ? [] : read.issues;
    }
    case "governance": {
      const read = readTomlFile(text, "governance/v1", governanceSchema);
      return read.ok ? [] : read.issues;
    }
    case "agent": {
      const read = readTomlFile(text, "agent/v1", agentSchema);
      return read.ok ? [] : read.issues;
    }
    case "toolbelt": {
      const read = readTomlFile(text, "toolbelt/v1", toolbeltSchema);
      return read.ok ? [] : read.issues;
    }
    default:
      return [];
  }
}

function caseInput(item: InvalidCase): CheckInput {
  const health = item.actual_settings
    ? { differences: settingsDifferences(item.actual_settings.provider, item.actual_settings.settings) }
    : { differences: [] };
  return inputFor(item.files, { health });
}

type Place = InvalidCase["expect"][number];

function at(item: InvalidCase, place: Place, finding: Finding): boolean {
  const line = LINE_ERRATA[item.id] ?? place.line;
  return (
    finding.check === item.check &&
    finding.rule === item.rule &&
    finding.severity === item.severity &&
    finding.path === place.path &&
    (line === undefined || finding.line === line) &&
    (place.field === undefined || finding.field === place.field)
  );
}

/** The messages a reader-refused schema case may carry at this place. */
function readerMessages(item: InvalidCase, place: Place): string[] {
  const text = item.files.get(place.path);
  if (text === undefined) return [];
  return readerIssues(place.path, text)
    .filter((issue) => place.line === undefined || issue.line === place.line)
    .filter((issue) => place.field === undefined || issue.field === place.field)
    .map((issue) => sentence(issue.message));
}

function assertMessage(item: InvalidCase, place: Place, found: readonly Finding[]): void {
  const messages = found.map((finding) => finding.message);
  if (item.check === "schema" && item.refused_by_reader) {
    const expected = readerMessages(item, place);
    expect(expected, `the S0 reader has no issue at ${JSON.stringify(place)}`).not.toHaveLength(0);
    const hit = messages.some((message) => expected.some((tail) => message.endsWith(tail)));
    expect(hit, `${JSON.stringify(messages)} carries none of ${JSON.stringify(expected)}`).toBe(true);
    return;
  }
  const expected = MESSAGES[item.id];
  expect(expected, `no expected message for ${item.id}`).toBeDefined();
  if (typeof expected === "string") expect(messages).toContain(expected);
  else expect(messages).toContainEqual(expect.stringMatching(expected as RegExp));
}

function errors(report: CheckReport): Finding[] {
  return report.findings.filter((finding) => finding.severity === "error");
}

describe("invalid fixture cases", () => {
  const cases = invalidCases();

  it("covers every check a steering PR runs", () => {
    expect([...STEERING_CHECK_NAMES]).toEqual([...FIXTURE_CHECKS]);
    expect(new Set(cases.map((item) => item.check))).toEqual(new Set(FIXTURE_CHECKS));
  });

  it.each(cases.map((item) => [item.id, item] as const))("%s gives its finding", (_id, item) => {
    const report = runChecks(caseInput(item));
    const ofCheck = report.findings.filter((finding) => finding.check === item.check);
    for (const place of item.expect) {
      const found = report.findings.filter((finding) => at(item, place, finding));
      expect(found, `${JSON.stringify(place)} in ${JSON.stringify(ofCheck, null, 2)}`).not.toHaveLength(0);
      for (const finding of found) {
        expect(finding.expected).not.toBe("");
        expect(finding.fix).not.toBe("");
      }
      assertMessage(item, place, found);
    }
    if (item.severity === "error") expect(report.passed).toBe(false);
  });
});

/** The valid record every fixture case leaves alone, with one word changed and no stamp. */
const VALID_RECORD = "steering/brand/a-intel.brand.plain-words.md";

function editValidRecord(tree: Map<string, string>): Map<string, string> {
  const text = tree.get(VALID_RECORD);
  if (text === undefined) throw new Error(`${VALID_RECORD} is missing from the fixture repo`);
  const edited = text
    .replace("with numbers over", "with figures over")
    .split("\n")
    .filter((line) => !line.startsWith("id: ") && !line.startsWith("hash: "))
    .join("\n");
  tree.set(VALID_RECORD, edited);
  return tree;
}

describe("a steering PR that changes one valid record", () => {
  const head = editValidRecord(fixtureRepo());

  it("changes only that record", () => {
    const base = fixtureRepo();
    const changed = [...head].filter(([path, text]) => base.get(path) !== text).map(([path]) => path);
    expect(changed).toEqual([VALID_RECORD]);
    expect(head.get(VALID_RECORD)).not.toMatch(/^(id|hash): /m);
  });

  it("passes every check", () => {
    const report = runChecks(inputFor(head));
    expect(report.findings).toEqual([]);
    expect(report.passed).toBe(true);
    for (const check of ["schema", "lineage", "hash", "secrets", "conflicts", "authority"] as const) {
      expect(report.results.find((entry) => entry.check === check)?.status).toBe("passed");
    }
    expect(report.results.every((entry) => entry.status !== "failed")).toBe(true);
  });

  it("passes every check with no production branch to compare", () => {
    const report = runChecks(inputFor(head, { base: null }));
    expect(errors(report)).toEqual([]);
  });
});

describe("the valid fixture repo", () => {
  it("finds nothing against itself", () => {
    const report = runChecks(inputFor(fixtureRepo()));
    expect(report.findings).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("passes as a whole tree", () => {
    const report = runChecks(inputFor(fixtureRepo(), { base: null }));
    expect(errors(report)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("renders each always-on block as the bundle holds it", () => {
    const blocks = new Map(alwaysOnBlocks(fixtureRepo()).map((block) => [block.repository, block]));
    const published = fixtureBundle().always_on;
    expect(published.length).toBeGreaterThan(0);
    for (const expected of published) {
      const block = blocks.get(expected.repository);
      expect(block, `no block for ${String(expected.repository)}`).toBeDefined();
      expect(block?.text).toBe(expected.text);
      expect(block?.tokens).toBe(expected.tokens);
      expect(block?.entries.map((entry) => entry.lineage)).toEqual(expected.lineages);
    }
  });
});
