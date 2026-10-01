// parse.test.ts: parse_markdown_import over fake deps. The model call, the
// registry, and the steering repo are fakes. The detection, the split rules,
// the Cedar reading, and the conflicts test are the real ones.
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ assertContractRole: vi.fn() }));
vi.mock("../lib/capability-role-guard", () => guard);
vi.mock("@oxagen/ai", () => ({
  selectModelForOrg: vi.fn(() => {
    throw new Error("each test passes its own model");
  }),
  generateObjectFor: vi.fn(() => {
    throw new Error("each test passes its own model call");
  }),
}));

import type { CapabilityContext } from "@oxagen/oxagen";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import { forceAllowed } from "@oxagen/oxagen/steering-repo/record-force";
import type { MarkdownImportDeps } from "./deps";
import { createParseMarkdownImportHandler, detectTarget } from "./parse";
import type { SplitModel, SplitOutput } from "./split";

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  surface: "api",
} as unknown as CapabilityContext;

const CLAUDE_MD = [
  "# Rules",
  "",
  "- Never push to main.",
  "- Prefer rg over grep.",
  "- CI runs on every push.",
  "- Open every change as a pull request from a branch named for the work.",
].join("\n");

const FRONTMATTER_RECORD = [
  "---",
  "schema: steering-record/v1",
  "lineage: a-intel.platform.release-steps",
  "label: Release steps",
  "kind: procedure",
  "force: should",
  "scope: workspace",
  "status: active",
  "origin: user",
  "provenance:",
  "  source: proposal",
  "  uri: oxagen:proposal/prp_01",
  "---",
  "",
  "1. Tag the release.",
  "",
].join("\n");

const POLICY_MD = [
  "# No branch delete",
  "",
  "Agents never delete a branch.",
  "",
  "```cedar",
  'forbid (principal, action == Action::"github__delete_branch", resource);',
  "```",
].join("\n");

const SPLIT: SplitOutput = {
  statements: [
    {
      statement: "Never push to main.",
      label: "No push to main",
      line: 3,
      kind: "constraint",
      kindReason: "It forbids an action.",
      force: "must",
      forceWords: "Never",
      effect: "forbid",
    },
    {
      statement: "Prefer rg over grep.",
      label: "Prefer rg",
      line: 4,
      kind: "preference",
      kindReason: "It states a tool preference.",
      // A preference cannot be must. The handler moves it to may.
      force: "must",
      forceWords: "Prefer",
      effect: null,
    },
    {
      statement: "CI runs on every push.",
      label: "CI on push",
      line: 5,
      kind: "fact",
      kindReason: "It says how the work is.",
      force: "info",
      forceWords: "",
      effect: null,
    },
    {
      statement: "Open every change as a pull request from a branch named for the work.",
      label: "Pull request per change",
      line: 6,
      kind: "business-rule",
      kindReason: "It is how work reaches main.",
      force: "should",
      forceWords: "",
      effect: null,
    },
  ],
};

function deps(over: Partial<MarkdownImportDeps> = {}): MarkdownImportDeps {
  return {
    names: async () => ({ organization: "a-intel", workspace: "core" }),
    publishedRecords: async () => [],
    publishedPolicies: async () => [],
    split: vi.fn<SplitModel>().mockResolvedValue(SPLIT),
    branchTaken: async () => false,
    opener: { open: vi.fn() },
    now: () => new Date("2026-09-30T12:00:00Z"),
    ...over,
  };
}

const run = (d: MarkdownImportDeps, documents: unknown[]) =>
  createParseMarkdownImportHandler(d)(
    steeringMarkdownImportParse.input.parse({ documents }),
    ctx,
  );

beforeEach(() => {
  guard.assertContractRole.mockReset();
  guard.assertContractRole.mockResolvedValue(undefined);
});

describe("detectTarget", () => {
  it("sends a file with a cedar block to policies", () => {
    expect(detectTarget({ filename: "no-branch-delete.md", content: POLICY_MD }).target).toBe("policies");
  });

  it("skips a README and a file of only links", () => {
    expect(detectTarget({ filename: "docs/README.md", content: "Some prose." }).target).toBe("skip");
    expect(detectTarget({ filename: "toc.md", content: "# Docs\n\n- [Release](release.md)\n- [Style](style.md)\n" }).target).toBe(
      "skip",
    );
  });

  it("sends any other file to records", () => {
    expect(detectTarget({ filename: "CLAUDE.md", content: CLAUDE_MD }).target).toBe("records");
  });
});

describe("parse_markdown_import", () => {
  it("checks the caller's role from the contract before it reads anything", async () => {
    guard.assertContractRole.mockRejectedValue(new Error("forbidden"));
    const d = deps();
    await expect(run(d, [{ filename: "CLAUDE.md", content: CLAUDE_MD }])).rejects.toThrow("forbidden");
    expect(guard.assertContractRole).toHaveBeenCalledWith(steeringMarkdownImportParse, ctx);
    expect(d.split).not.toHaveBeenCalled();
  });

  it("splits a file into one row per statement with kind, force, words, line, and lineage", async () => {
    const d = deps();
    const out = await run(d, [{ filename: "CLAUDE.md", content: CLAUDE_MD }]);
    expect(d.split).toHaveBeenCalledTimes(1);
    expect(out.files).toEqual([
      expect.objectContaining({ filename: "CLAUDE.md", target: "records", detected: "records", records: 4, error: null }),
    ]);
    expect(out.records.map((r) => [r.lineage, r.kind, r.force, r.forceWords, r.effect, r.line, r.action])).toEqual([
      ["a-intel.claude.no-push-to-main", "constraint", "must", "Never", "forbid", 3, "add"],
      ["a-intel.claude.prefer-rg", "preference", "may", "", null, 4, "add"],
      ["a-intel.claude.ci-on-push", "fact", "info", "", null, 5, "add"],
      ["a-intel.claude.pull-request-per-change", "business-rule", "should", "", null, 6, "add"],
    ]);
    // No row carries a force its kind forbids, and every constraint has an effect.
    for (const r of out.records) {
      expect(forceAllowed(r.kind, r.force)).toBe(true);
      expect(r.kind === "constraint" ? r.effect !== null : r.effect === null).toBe(true);
    }
    expect(steeringMarkdownImportParse.output.safeParse(out).success).toBe(true);
  });

  it("keeps a steering-record/v1 file as one record and calls no model", async () => {
    const d = deps();
    const out = await run(d, [{ filename: "release-steps.md", content: FRONTMATTER_RECORD }]);
    expect(d.split).not.toHaveBeenCalled();
    expect(out.records).toEqual([
      expect.objectContaining({
        origin: "frontmatter",
        lineage: "a-intel.platform.release-steps",
        kind: "procedure",
        force: "should",
        statement: "1. Tag the release.",
        line: 15,
        action: "add",
      }),
    ]);
    expect(out.records[0]?.frontmatter).toContain("schema: steering-record/v1");
  });

  it("holds a frontmatter record to the force rule too (negative)", async () => {
    const fact = FRONTMATTER_RECORD.replace("kind: procedure", "kind: fact").replace("force: should", "force: must");
    const out = await run(deps(), [{ filename: "release-steps.md", content: fact }]);
    expect(out.records[0]).toMatchObject({ kind: "fact", force: "info" });
    expect(out.records[0]?.kindReason).toContain("A fact cannot carry must, so its force is info.");
    expect(steeringMarkdownImportParse.output.safeParse(out).success).toBe(true);
  });

  it("marks a statement a published record already says as a duplicate, and skips it", async () => {
    const d = deps({
      publishedRecords: async () => [
        {
          lineage: "a-intel.platform.no-push-to-main",
          kind: "constraint",
          effect: "forbid",
          statement: "Never push to main.",
          path: "steering/platform/a-intel.platform.no-push-to-main.md",
        },
      ],
    });
    const out = await run(d, [{ filename: "CLAUDE.md", content: CLAUDE_MD }]);
    expect(out.records[0]).toMatchObject({
      action: "skip",
      duplicate: { lineage: "a-intel.platform.no-push-to-main", published: true },
    });
  });

  it("leaves a conflict for a person to choose", async () => {
    const d = deps({
      publishedRecords: async () => [
        {
          lineage: "a-intel.platform.main-pushes",
          kind: "constraint",
          effect: "require",
          statement: "Never push to main.",
          path: null,
        },
      ],
    });
    const out = await run(d, [{ filename: "CLAUDE.md", content: CLAUDE_MD }]);
    expect(out.records[0]).toMatchObject({ action: null, conflict: { lineage: "a-intel.platform.main-pushes" } });
  });

  it("marks the second of two files that say the same thing", async () => {
    const d = deps();
    const out = await run(d, [
      { filename: "CLAUDE.md", content: CLAUDE_MD },
      { filename: "AGENTS.md", content: CLAUDE_MD },
    ]);
    expect(d.split).toHaveBeenCalledTimes(2);
    const agents = out.records.filter((r) => r.file === "AGENTS.md");
    expect(agents.every((r) => r.action === "skip" && r.duplicate?.published === false)).toBe(true);
    expect(agents[0]?.lineage).toBe("a-intel.agents.no-push-to-main");
  });

  it("turns a policy file's cedar block into policy/<slug>.cedar", async () => {
    const d = deps();
    const out = await run(d, [{ filename: "policies/No branch delete.md", content: POLICY_MD }]);
    expect(d.split).not.toHaveBeenCalled();
    expect(out.records).toEqual([]);
    expect(out.policies).toEqual([
      expect.objectContaining({
        file: "policies/No branch delete.md",
        path: "policy/no-branch-delete.cedar",
        statements: [{ id: "no-branch-delete", line: 6, effect: "forbid" }],
        issues: [],
        duplicate: null,
        replaces: false,
        action: "add",
      }),
    ]);
    expect(out.files[0]).toMatchObject({ target: "policies", policies: 1 });
  });

  it("skips a policy whose statements a published policy file already holds", async () => {
    const d = deps();
    const first = await run(d, [{ filename: "no-branch-delete.md", content: POLICY_MD }]);
    const text = first.policies[0]?.text as string;
    const again = await run(
      deps({ publishedPolicies: async () => [{ path: "policy/no-branch-delete.cedar", text }] }),
      [{ filename: "no-branch-delete.md", content: POLICY_MD }],
    );
    expect(again.policies[0]).toMatchObject({
      duplicate: { path: "policy/no-branch-delete.cedar" },
      replaces: false,
      action: "skip",
      issues: [],
    });
  });

  it("refuses a policy with a broken statement, and one whose path another file takes (negative)", async () => {
    const broken = POLICY_MD.replace("forbid (", "forbidd (");
    const out = await run(deps(), [
      { filename: "a/no-branch-delete.md", content: broken },
      { filename: "b/no-branch-delete.md", content: POLICY_MD },
    ]);
    expect(out.policies[0]?.action).toBe("skip");
    expect(out.policies[0]?.issues[0]?.message).toContain("has forbidd where permit or forbid belongs");
    expect(out.policies[1]?.issues.map((i) => i.message)).toContain(
      "a/no-branch-delete.md in this import also becomes policy/no-branch-delete.cedar. Rename one of the two files.",
    );
  });

  it("honors a target the caller chose over the one the text implies", async () => {
    const d = deps();
    const out = await run(d, [
      { filename: "CLAUDE.md", content: CLAUDE_MD, target: "skip" },
      { filename: "README.md", content: CLAUDE_MD, target: "records" },
    ]);
    expect(out.files.map((f) => [f.filename, f.target, f.detected])).toEqual([
      ["CLAUDE.md", "skip", "records"],
      ["README.md", "records", "skip"],
    ]);
    expect(d.split).toHaveBeenCalledTimes(1);
  });

  it("reports a file the model fails on and reads the others (negative)", async () => {
    const split = vi
      .fn<SplitModel>()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce(SPLIT);
    const out = await run(deps({ split }), [
      { filename: "broken.md", content: CLAUDE_MD },
      { filename: "CLAUDE.md", content: CLAUDE_MD },
    ]);
    expect(out.files[0]).toMatchObject({
      filename: "broken.md",
      records: 0,
      error: "The model could not split the file: gateway down",
    });
    expect(out.records).toHaveLength(4);
  });

  it("reports a file with no guidance, and one with frontmatter that does not read", async () => {
    const split = vi.fn<SplitModel>().mockResolvedValue({ statements: [] });
    const out = await run(deps({ split }), [
      { filename: "empty.md", content: "Some notes." },
      { filename: "bad.md", content: FRONTMATTER_RECORD.replace("kind: procedure", "kind: decision") },
    ]);
    expect(out.files[0]?.error).toBe("The model found no durable guidance in the file.");
    expect(out.files[1]?.error).toContain("does not read as a record");
    expect(out.records).toEqual([]);
  });
});
