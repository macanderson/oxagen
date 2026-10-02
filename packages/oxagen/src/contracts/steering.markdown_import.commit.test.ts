import { describe, expect, it } from "vitest";
import { STEERING_PR_MAX_FILES } from "../steering-repo/names";
import {
  markdownImportCommitFields,
  steeringMarkdownImportCommit,
} from "./steering.markdown_import.commit";
import {
  markdownImportFileCount,
  markdownImportPolicySchema,
  markdownImportTooManyFiles,
  type MarkdownImportPolicy,
  type MarkdownImportRecord,
} from "./steering.markdown_import.shared";

function record(i: number, action: MarkdownImportRecord["action"] = "add"): MarkdownImportRecord {
  return {
    file: "rules.md",
    line: 1,
    origin: "split",
    lineage: `a-intel.rules.tool-${i}`,
    label: `Tool ${i}`,
    statement: `Use tool ${i}.`,
    kind: "code-rule",
    kindReason: "It says how code is written.",
    force: "should",
    forceWords: "",
    effect: null,
    tokens: 3,
    duplicate: null,
    conflict: null,
    action,
    frontmatter: null,
  };
}

function policy(i: number): MarkdownImportPolicy {
  return {
    file: `p${i}.md`,
    path: `policy/p${i}.cedar`,
    text: `@id("p${i}")\nforbid (principal, action, resource);\n`,
    statements: [{ id: `p${i}`, line: 2, effect: "forbid" }],
    issues: [],
    duplicate: null,
    replaces: false,
    action: "add",
  };
}

describe("the steering PR file limit", () => {
  it("is the 299 files one steering PR holds", () => {
    expect(STEERING_PR_MAX_FILES).toBe(299);
  });

  it("takes rows that mark 299 records and policies add, and counts no skipped row", () => {
    const records = Array.from({ length: 297 }, (_, i) => record(i));
    const input = { records: [...records, record(900, "skip")], policies: [policy(1), policy(2)] };
    expect(markdownImportFileCount(input)).toBe(299);
    expect(steeringMarkdownImportCommit.input.safeParse(input).success).toBe(true);
  });

  it("refuses rows that mark more, with a message that says what to do (negative)", () => {
    const input = { records: Array.from({ length: 298 }, (_, i) => record(i)), policies: [policy(1), policy(2)] };
    const parsed = steeringMarkdownImportCommit.input.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "The import marks 300 records and policy files add, and one steering PR holds at most 299 files. Mark 1 of them skip, or import the files in smaller sets.",
    ]);
    expect(markdownImportTooManyFiles(299)).toBeNull();
  });

  it("lists the commit's own fields for the MCP tool", () => {
    expect(Object.keys(markdownImportCommitFields).sort()).toEqual(["memories", "policies", "records"]);
  });
});

describe("commit_markdown_import", () => {
  it("defaults its rows to none", () => {
    expect(steeringMarkdownImportCommit.input.parse({})).toEqual({ records: [], policies: [], memories: [] });
  });

  it("answers the steering PR and what it holds", () => {
    const out = {
      pullRequest: { number: 7, url: "https://github.com/a/b/pull/7", branch: "steering/import-2026-09-30", headSha: "abc" },
      paths: ["policy/no-branch-delete.cedar"],
      records: 0,
      policies: 1,
      skipped: 0,
      memories: { stored: 0, skipped: [] },
    };
    expect(steeringMarkdownImportCommit.output.safeParse(out).success).toBe(true);
    expect(
      steeringMarkdownImportCommit.output.safeParse({ ...out, pullRequest: { ...out.pullRequest, number: 0 } }).success,
    ).toBe(false);
  });

  it("answers no PR for a commit of memories alone, and names each memory it left out", () => {
    const out = {
      pullRequest: null,
      paths: [],
      records: 0,
      policies: 0,
      skipped: 1,
      memories: {
        stored: 2,
        skipped: [
          { file: "notes.md", line: 4, reason: "waiting", memory: "mem_01" },
          { file: "notes.md", line: 5, reason: "rejected", memory: null },
          { file: "notes.md", line: 6, reason: "import", memory: null },
          { file: "notes.md", line: 7, reason: "stored", memory: null },
        ],
      },
    };
    expect(steeringMarkdownImportCommit.output.safeParse(out).success).toBe(true);
    expect(
      steeringMarkdownImportCommit.output.safeParse({
        ...out,
        memories: { stored: 0, skipped: [{ file: "a.md", line: 1, reason: "published", memory: null }] },
      }).success,
    ).toBe(false);
  });

  it("counts no memory against the steering PR's file limit", () => {
    const memories = Array.from({ length: 400 }, (_, i) => ({
      file: "notes.md",
      line: i + 1,
      label: `Lesson ${i}`,
      statement: `Lesson ${i}.`,
      kind: "memory",
      force: "info",
      duplicate: null,
      issue: null,
      action: "add",
    }));
    expect(steeringMarkdownImportCommit.input.safeParse({ memories }).success).toBe(true);
  });
});

describe("markdownImportPolicySchema", () => {
  it("holds a policy file under policy/", () => {
    const policy = {
      file: "no-branch-delete.md",
      path: "policy/no-branch-delete.cedar",
      text: '@id("no-branch-delete")\nforbid (principal, action, resource);\n',
      statements: [{ id: "no-branch-delete", line: 6, effect: "forbid" }],
      issues: [],
      duplicate: null,
      replaces: false,
      action: "add",
    };
    expect(markdownImportPolicySchema.safeParse(policy).success).toBe(true);
    expect(markdownImportPolicySchema.safeParse({ ...policy, path: "steering/x.cedar" }).success).toBe(false);
    expect(markdownImportPolicySchema.safeParse({ ...policy, path: "policy/x.tests.jsonl" }).success).toBe(false);
  });
});
