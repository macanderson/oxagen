import { describe, expect, it } from "vitest";
import { steeringMarkdownImportCommit } from "./steering.markdown_import.commit";
import { markdownImportPolicySchema } from "./steering.markdown_import.shared";

describe("commit_markdown_import", () => {
  it("defaults its rows to none", () => {
    expect(steeringMarkdownImportCommit.input.parse({})).toEqual({ records: [], policies: [] });
  });

  it("answers the steering PR and what it holds", () => {
    const out = {
      pullRequest: { number: 7, url: "https://github.com/a/b/pull/7", branch: "steering/import-2026-09-30", headSha: "abc" },
      paths: ["policy/no-branch-delete.cedar"],
      records: 0,
      policies: 1,
      skipped: 0,
    };
    expect(steeringMarkdownImportCommit.output.safeParse(out).success).toBe(true);
    expect(
      steeringMarkdownImportCommit.output.safeParse({ ...out, pullRequest: { ...out.pullRequest, number: 0 } }).success,
    ).toBe(false);
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
