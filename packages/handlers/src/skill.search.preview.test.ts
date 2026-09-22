import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { skillConfigSchema } from "@oxagen/oxagen/skills";
import {
  createSkillSearchPreviewHandler,
  rankSkillDescriptions,
  readSkillCatalog,
} from "./skill.search.preview";
import { makeCTX } from "./test-utils/fixtures";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

const digest = `sha256:${"a".repeat(64)}`;
const currentSha = "b".repeat(40);
const candidate = {
  id: "review",
  version: "1.0.0",
  digest,
  source: "workspace",
  description: "Review code",
  tokenCost: 100,
};
const repository = (github: Partial<GitHubClient>) => ({
  bindingId: "binding",
  owner: "owner",
  repo: "repo",
  fullName: "owner/repo",
  productionBranch: "release",
  github: github as GitHubClient,
});
const snapshot = {
  id: "skv_123",
  version: "skl_v1",
  repositoryBindingId: "binding",
  config: skillConfigSchema.parse({
    enabled: true,
    sources: [
      {
        id: "workspace",
        path: ".oxagen/skills",
        skills: [{ id: "review", version: "1.0.0", digest }],
      },
    ],
  }),
  commitSha: "a".repeat(40),
  digest,
  pullRequestNumber: 12,
  publishedAt: "2026-09-20T10:00:00.000Z",
};

describe("preview_skill_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.assertOrgRole.mockResolvedValue(undefined);
    gate.resolveActingUserId.mockResolvedValue("owner");
  });
  it("evaluates current skill bytes against the selected config and shows withheld names only to the person", async () => {
    const repo = repository({
      getBranch: vi
        .fn()
        .mockResolvedValue({ name: "release", sha: currentSha }),
    });
    const catalog = vi.fn().mockResolvedValue({
      candidates: [{ ...candidate, digest: `sha256:${"c".repeat(64)}` }],
      unpinned: [],
    });
    const handler = createSkillSearchPreviewHandler({
      store: { list: vi.fn().mockResolvedValue([snapshot]), publish: vi.fn() },
      repository: vi.fn().mockResolvedValue(repo),
      catalog,
    });
    const result = await handler(
      { version: "skl_v1", query: "review" },
      makeCTX(),
    );
    expect(catalog).toHaveBeenCalledWith(
      repo,
      currentSha,
      "workspace",
      new Set(["review"]),
    );
    expect(result).toEqual({
      version: "skl_v1",
      repositoryCommitSha: currentSha,
      results: [],
      tokenCost: 0,
      withheld: [{ id: "review", reason: "unapproved_digest" }],
    });
    expect(skillSearchPreview.output.parse(result)).toEqual(result);
    expect(gate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner" }),
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
  });
  it("refuses missing versions, changed bindings and denied actors before reading skill bodies", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const resolve = vi
      .fn()
      .mockResolvedValue({ ...repository({}), bindingId: "other" });
    const catalog = vi.fn();
    const handler = createSkillSearchPreviewHandler({
      store: { list, publish: vi.fn() },
      repository: resolve,
      catalog,
    });
    await expect(
      handler({ version: "skl_v1", query: "review" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "skill_config_missing" });
    expect(resolve).not.toHaveBeenCalled();
    list.mockResolvedValue([snapshot]);
    await expect(
      handler({ version: "skl_v1", query: "review" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "skill_repository_changed" });
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    await expect(
      handler({ version: "skl_v1", query: "review" }, makeCTX()),
    ).rejects.toThrow("denied");
    expect(catalog).not.toHaveBeenCalled();
  });
  it("ranks distinct query terms without sending descriptions to a model", () => {
    expect(
      rankSkillDescriptions("review review code tests", [candidate]),
    ).toEqual([2 / 3]);
    expect(rankSkillDescriptions("!!!", [candidate])).toEqual([0]);
  });
});

describe("repository skill catalog", () => {
  it("reads only governed skill files at one immutable commit and hashes normalized bytes", async () => {
    const getFileContent = vi
      .fn()
      .mockResolvedValue(
        "---\r\nname: review\r\nversion: 1.0.0\r\nscope: workspace\r\ndescription: Review code\r\n---\r\nBody",
      );
    const repo = repository({
      getTree: vi
        .fn()
        .mockResolvedValue([
          ".oxagen/skills/review/SKILL.md",
          ".claude/skills/secret/SKILL.md",
          ".oxagen/skills/review/helper.ts",
        ]),
      getFileContent,
    });
    const [row] = (
      await readSkillCatalog(repo, currentSha, "workspace", new Set(["review"]))
    ).candidates;
    expect(row).toMatchObject({
      id: "review",
      version: "1.0.0",
      source: "workspace",
      description: "Review code",
    });
    expect(getFileContent).toHaveBeenCalledOnce();
    expect(getFileContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: ".oxagen/skills/review/SKILL.md",
      ref: currentSha,
    });
    const firstDigest = row!.digest;
    getFileContent.mockResolvedValue(
      "---\nname: review\nversion: 1.0.0\nscope: workspace\ndescription: Review code\n---\nBody",
    );
    expect(
      (
        await readSkillCatalog(
          repo,
          "c".repeat(40),
          "workspace",
          new Set(["review"]),
        )
      ).candidates[0]!.digest,
    ).toBe(firstDigest);
  });
  it("fails closed on an invalid or oversized catalog", async () => {
    const getTree = vi
      .fn()
      .mockResolvedValue([".oxagen/skills/review/SKILL.md"]);
    const repo = repository({
      getTree,
      getFileContent: vi.fn().mockResolvedValue("missing frontmatter"),
    });
    repo.bindingId = "invalid-catalog";
    await expect(
      readSkillCatalog(repo, currentSha, "workspace", new Set(["review"])),
    ).rejects.toMatchObject({ reason: "skill_catalog_invalid" });
    getTree.mockResolvedValue(
      Array.from(
        { length: 1001 },
        (_, index) => `.oxagen/skills/skill-${index}/SKILL.md`,
      ),
    );
    await expect(
      readSkillCatalog(repo, currentSha, "workspace", new Set(["review"])),
    ).rejects.toMatchObject({ reason: "skill_catalog_too_large" });
  });
});

// #3668: the tree is one request and every pinned skill is one more, so a
// preview's cost follows the approved set rather than the repository.
it("reads a large catalog inside a fixed request budget on a cold cache", async () => {
  const paths = Array.from(
    { length: 1000 },
    (_, index) => `.oxagen/skills/skill-${index}/SKILL.md`,
  );
  const github = {
    getTree: vi.fn().mockResolvedValue(paths),
    getFileContent: vi.fn(
      async ({ path }: { path: string }) =>
        `---\nname: ${path.split("/")[2]}\nscope: workspace\nversion: 1.0.0\n---\nBody`,
    ),
  };
  const repo = { ...repository(github), bindingId: "bounded-budget" };
  const pinned = new Set(["skill-1", "skill-2", "skill-3"]);
  const catalog = await readSkillCatalog(repo, currentSha, "workspace", pinned);
  expect(catalog.candidates.map((row) => row.id)).toEqual([
    "skill-1",
    "skill-2",
    "skill-3",
  ]);
  expect(catalog.unpinned).toHaveLength(997);
  // One tree call plus one per pinned skill, against 1,001 before #3668.
  expect(github.getTree).toHaveBeenCalledOnce();
  expect(github.getFileContent).toHaveBeenCalledTimes(3);
  expect(
    github.getTree.mock.calls.length + github.getFileContent.mock.calls.length,
  ).toBeLessThanOrEqual(8);
});

it("coalesces and reuses a 1000-file immutable catalog, and separates binding and commit changes", async () => {
  const paths = Array.from(
    { length: 1000 },
    (_, index) => `.oxagen/skills/skill-${index}/SKILL.md`,
  );
  const github = {
    getTree: vi.fn().mockResolvedValue(paths),
    getFileContent: vi.fn(
      async ({ path }: { path: string }) =>
        `---\nname: ${path.split("/")[2]}\nversion: 1.0.0\nscope: workspace\n---\nBody`,
    ),
  };
  const repo = { ...repository(github), bindingId: "large-catalog" };
  const pinned = new Set(paths.map((path) => path.split("/")[2]!));
  const [first, concurrent] = await Promise.all([
    readSkillCatalog(repo, currentSha, "workspace", pinned),
    readSkillCatalog(repo, currentSha, "workspace", pinned),
  ]);
  expect(first.candidates).toHaveLength(1000);
  expect(concurrent).toEqual(first);
  expect(github.getTree).toHaveBeenCalledOnce();
  expect(github.getFileContent).toHaveBeenCalledTimes(1000);
  first.candidates[0]!.description = "Mutated caller result";
  expect(
    (await readSkillCatalog(repo, currentSha, "workspace", pinned))
      .candidates[0]?.description,
  ).toBe("");
  expect(github.getFileContent).toHaveBeenCalledTimes(1000);
  await readSkillCatalog(repo, "d".repeat(40), "workspace", pinned);
  await readSkillCatalog(
    { ...repo, bindingId: "other-tenant-binding" },
    currentSha,
    "workspace",
    pinned,
  );
  expect(github.getTree).toHaveBeenCalledTimes(3);
  expect(github.getFileContent).toHaveBeenCalledTimes(3000);
});

it("bounds cached catalogs and separates source labels and pinned sets", async () => {
  const getTree = vi.fn().mockResolvedValue([]);
  const repo = { ...repository({ getTree }), bindingId: "cache-retention" };
  const pinned = new Set(["review"]);
  const commits = Array.from({ length: 9 }, (_, index) =>
    String(index).repeat(40),
  );
  for (const commit of commits)
    await readSkillCatalog(repo, commit, "workspace", pinned);
  expect(getTree).toHaveBeenCalledTimes(9);
  await readSkillCatalog(repo, commits[0]!, "workspace", pinned);
  expect(getTree).toHaveBeenCalledTimes(10);
  await readSkillCatalog(repo, commits[8]!, "workspace", pinned);
  expect(getTree).toHaveBeenCalledTimes(10);
  await readSkillCatalog(repo, commits[8]!, "another-source", pinned);
  expect(getTree).toHaveBeenCalledTimes(11);
  // A republished configuration changes which files the read fetched, so it is
  // a different catalog rather than a hit on the one before it.
  await readSkillCatalog(
    repo,
    commits[8]!,
    "another-source",
    new Set(["review", "triage"]),
  );
  expect(getTree).toHaveBeenCalledTimes(12);
});
