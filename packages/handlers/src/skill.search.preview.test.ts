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
    const catalog = vi
      .fn()
      .mockResolvedValue([
        { ...candidate, digest: `sha256:${"c".repeat(64)}` },
      ]);
    const handler = createSkillSearchPreviewHandler({
      store: { list: vi.fn().mockResolvedValue([snapshot]), publish: vi.fn() },
      repository: vi.fn().mockResolvedValue(repo),
      catalog,
    });
    const result = await handler(
      { version: "skl_v1", query: "review" },
      makeCTX(),
    );
    expect(catalog).toHaveBeenCalledWith(repo, currentSha, "workspace");
    expect(skillSearchPreview.output.parse(result)).toMatchObject({
      version: "skl_v1",
      repositoryCommitSha: currentSha,
      results: [],
      tokenCost: 0,
      withheld: [{ id: "review", reason: "unapproved_digest" }],
    });
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
    const [row] = await readSkillCatalog(repo, currentSha, "workspace");
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
      (await readSkillCatalog(repo, currentSha, "workspace"))[0]!.digest,
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
    await expect(
      readSkillCatalog(repo, currentSha, "workspace"),
    ).rejects.toMatchObject({ reason: "skill_catalog_invalid" });
    getTree.mockResolvedValue(
      Array.from(
        { length: 1001 },
        (_, index) => `.oxagen/skills/skill-${index}/SKILL.md`,
      ),
    );
    await expect(
      readSkillCatalog(repo, currentSha, "workspace"),
    ).rejects.toMatchObject({ reason: "skill_catalog_too_large" });
  });
});
