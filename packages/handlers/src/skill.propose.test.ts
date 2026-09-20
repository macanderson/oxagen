// propose_skill against the in-memory GitHub the steering handlers use: what
// reaches the repository, what the call refuses, and that a refusal writes
// nothing. The role gate is the org-role module, faked the way the Context PR
// tests fake it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (
    actor: { userId: string | null },
    roles: { org: string[] },
  ) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse || !roles.org.includes("Owner"))
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Owner";
  },
}));

import { createProposeSkillHandler } from "./skill.propose";
import { ctx, FakeGitHub, REPO } from "./context.steering.test-support";

const skill = (version: string, extra?: string) =>
  [
    "---",
    "name: release-notes",
    `version: ${version}`,
    "scope: workspace:core-platform",
    ...(extra === undefined ? [] : [extra]),
    "---",
    "",
    "# Release notes",
    "",
    "1. Group merged pull requests by surface.",
    "",
  ].join("\n");

const input = (over: Record<string, unknown> = {}) =>
  skillPropose.input.parse({
    origin: "describe",
    name: "release-notes",
    body: skill("0.1.0"),
    rationale: "How we cut release notes.",
    ...over,
  });

let github: FakeGitHub;
const handler = () => createProposeSkillHandler({ github });

beforeEach(() => {
  gate.refuse = false;
  github = new FakeGitHub();
});

describe("propose_skill", () => {
  it("refuses to reset or write the production branch", async () => {
    github.repository = { ...REPO, defaultBranch: "skills/release-notes" };
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "production_branch_is_proposal_branch",
    });
    expect(github.deletedBranches).toEqual([]);
    expect(github.commits).toEqual([]);
  });

  it("cuts skills/<name> from the production branch, commits SKILL.md and opens the pull request", async () => {
    const out = await handler()(input(), ctx());

    expect(github.branches).toEqual([
      { branch: "skills/release-notes", from: "main" },
    ]);
    expect(github.commits).toEqual([
      {
        path: ".oxagen/skills/release-notes/SKILL.md",
        branch: "skills/release-notes",
        message: "skills: add release-notes 0.1.0",
      },
    ]);
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/release-notes/SKILL.md",
        "skills/release-notes",
      ),
    ).toBe(skill("0.1.0"));
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]).toMatchObject({
      title: "Skill: release-notes",
      head: "skills/release-notes",
      base: "main",
    });
    expect(github.pulls[0]!.body).toContain("How we cut release notes.");
    expect(github.pulls[0]!.body).toContain("This file grants nothing.");

    expect(out).toMatchObject({
      name: "release-notes",
      path: ".oxagen/skills/release-notes/SKILL.md",
      branch: "skills/release-notes",
      repository: "a-intel/platform",
      baseRef: "main",
      version: "0.1.0",
      replaces: null,
      budget: 6000,
      pullRequest: { number: github.pulls[0]!.number },
    });
    expect(out.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.checks.every((c) => c.passed)).toBe(true);
    expect(skillPropose.output.parse(out)).toEqual(out);
  });

  it("commits every bundle file beside SKILL.md", async () => {
    await handler()(
      input({
        origin: "upload",
        files: [
          { path: "examples/before.md", content: "before" },
          { path: "LICENSE", content: "MIT" },
        ],
      }),
      ctx(),
    );
    expect(github.commits.map((c) => c.path)).toEqual([
      ".oxagen/skills/release-notes/SKILL.md",
      ".oxagen/skills/release-notes/examples/before.md",
      ".oxagen/skills/release-notes/LICENSE",
    ]);
    expect(github.pulls[0]!.body).toContain("uploaded bundle");
  });

  it("removes omitted bundle files while retaining the open pull request", async () => {
    const first = await handler()(
      input({ files: [{ path: "old.md", content: "old" }] }),
      ctx(),
    );
    const next = await handler()(
      input({ files: [{ path: "new.md", content: "new" }] }),
      ctx(),
    );
    expect(next.pullRequest.number).toBe(first.pullRequest.number);
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/release-notes/old.md",
        next.branch,
      ),
    ).toBeNull();
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/release-notes/new.md",
        next.branch,
      ),
    ).toBe("new");
  });

  it("removes omitted files inherited from the merged bundle", async () => {
    github = new FakeGitHub({
      "main:.oxagen/skills/release-notes/SKILL.md": skill("0.1.0"),
      "main:.oxagen/skills/release-notes/old.md": "old",
    });
    const proposal = await handler()(input({ body: skill("0.2.0") }), ctx());
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/release-notes/old.md",
        proposal.branch,
      ),
    ).toBeNull();
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/release-notes/old.md",
        "main",
      ),
    ).toBe("old");
  });

  it("preserves an open proposal targeting the former production branch", async () => {
    const first = await handler()(input(), ctx());
    github.repository = { ...REPO, defaultBranch: "production" };
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "proposal_branch_exists",
    });
    expect(github.pulls[0]?.state).toBe("open");
    expect(github.pulls[0]?.number).toBe(first.pullRequest.number);
    expect(github.deletedBranches).toEqual([]);
  });

  it("preserves a rejected branch until its owner explicitly removes it", async () => {
    const first = await handler()(input(), ctx());
    github.commit(first.branch, "unreviewed.md", "rejected content");
    await github.closePullRequest(REPO, first.pullRequest.number);
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "proposal_branch_exists",
    });
    expect(await github.readFile(REPO, "unreviewed.md", first.branch)).toBe(
      "rejected content",
    );
    expect(github.deletedBranches).toEqual([]);
  });

  it("preserves a preexisting branch with no proposal", async () => {
    github.commit("skills/release-notes", "work.md", "unmerged work");
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "proposal_branch_exists",
    });
    expect(await github.readFile(REPO, "work.md", "skills/release-notes")).toBe(
      "unmerged work",
    );
    expect(github.deletedBranches).toEqual([]);
  });

  it.each([
    '"allowed-tools": Bash',
    "'allowed-tools': [Bash]",
    '"allowed\\u002Dtools": Bash',
  ])("refuses YAML grant keys: %s", async (grant) => {
    await expect(
      handler()(input({ body: skill("0.1.0", grant) }), ctx()),
    ).rejects.toMatchObject({ reason: "skill_check_grants" });
    expect(github.commits).toEqual([]);
  });

  it.each([
    "name: duplicate",
    "tools: [unterminated",
    "<<: *missing",
    "<<: {allowed-tools: Bash}",
    '"<<": {allowed-tools: Bash}',
  ])("refuses malformed or ambiguous YAML: %s", async (line) => {
    await expect(
      handler()(input({ body: skill("0.1.0", line) }), ctx()),
    ).rejects.toMatchObject({ reason: "skill_check_frontmatter" });
    expect(github.commits).toEqual([]);
  });

  it("replaces a merged skill only with a strictly greater version", async () => {
    github = new FakeGitHub({
      "main:.oxagen/skills/release-notes/SKILL.md": skill("2.1.0"),
    });
    const out = await handler()(input({ body: skill("2.2.0") }), ctx());
    expect(out).toMatchObject({ version: "2.2.0", replaces: "2.1.0" });
    expect(github.pulls[0]!.title).toBe("Skill: release-notes 2.2.0");

    github = new FakeGitHub({
      "main:.oxagen/skills/release-notes/SKILL.md": skill("2.1.0"),
    });
    await expect(
      handler()(input({ body: skill("2.1.0") }), ctx()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "skill_check_version",
    });
    expect(github.commits).toEqual([]);
    expect(github.pulls).toEqual([]);
  });

  it("refuses a file that grants a tool, and writes nothing (negative)", async () => {
    await expect(
      handler()(input({ body: skill("0.1.0", "allowed-tools: Bash") }), ctx()),
    ).rejects.toMatchObject({ reason: "skill_check_grants" });
    expect(github.branches).toEqual([]);
    expect(github.commits).toEqual([]);
  });

  it("refuses a credential anywhere in the bundle (negative)", async () => {
    await expect(
      handler()(
        input({
          files: [
            {
              path: "examples/env.md",
              content: "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
            },
          ],
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "skill_check_secrets" });
    expect(github.commits).toEqual([]);
  });

  it("holds the load cost against the budget .oxagen/skills.toml names", async () => {
    github = new FakeGitHub({
      "main:.oxagen/skills.toml": "enabled = true\n[search]\nbudget = 20\n",
    });
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "skill_check_load_cost",
    });
  });

  it("lands a second proposal on the pull request already open", async () => {
    await handler()(input(), ctx());
    const again = await handler()(input({ body: skill("0.1.1") }), ctx());
    expect(github.pulls).toHaveLength(1);
    expect(again.pullRequest.number).toBe(github.pulls[0]!.number);
    expect(github.commits).toHaveLength(2);
  });

  it("refuses a caller who is not an org Owner or Admin before reading GitHub (negative)", async () => {
    gate.refuse = true;
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(github.branches).toEqual([]);
  });

  it("refuses a merged skill with no version rather than guessing one (negative)", async () => {
    github = new FakeGitHub({
      "main:.oxagen/skills/release-notes/SKILL.md": "# no frontmatter\n",
    });
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "skill_merged_unversioned",
    });
  });

  it("says so when the workspace binds no main repository (negative)", async () => {
    github.repository = null;
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "workspace_repository_missing",
    });
  });
});
