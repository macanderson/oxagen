import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { skillConfigSchema } from "@oxagen/oxagen/skills";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { skillSearchSummarize } from "@oxagen/oxagen/contracts/skill.search.summarize";
import { createSkillSearchSummarizeHandler } from "./skill.search.summarize";
import { makeCTX } from "./test-utils/fixtures";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

const digest = `sha256:${"a".repeat(64)}`;
const currentSha = "b".repeat(40);
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
const repository = {
  bindingId: "binding",
  owner: "owner",
  repo: "repo",
  fullName: "owner/repo",
  productionBranch: "release",
  github: {
    getBranch: vi.fn().mockResolvedValue({ name: "release", sha: currentSha }),
  } as unknown as GitHubClient,
};

describe("summarize_skill_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.assertOrgRole.mockResolvedValue(undefined);
    gate.resolveActingUserId.mockResolvedValue("owner");
  });

  // #3669: the person's projection names withheld skills, so the capability that
  // carries it declares no MCP surface and the kernel refuses that dispatch.
  it("keeps the named withheld projection off MCP and the counts-only one on it", () => {
    expect(skillSearchPreview.surfaces).toEqual(["api"]);
    expect(skillSearchSummarize.surfaces).toEqual(["mcp"]);
  });

  it("counts withheld skills by reason and returns no withheld identifier", async () => {
    const handler = createSkillSearchSummarizeHandler({
      store: { list: vi.fn().mockResolvedValue([snapshot]), publish: vi.fn() },
      repository: vi.fn().mockResolvedValue(repository),
      catalog: vi.fn().mockResolvedValue({
        candidates: [
          {
            id: "review",
            version: "1.0.0",
            digest: `sha256:${"c".repeat(64)}`,
            source: "workspace",
            description: "Review code",
            tokenCost: 100,
          },
        ],
        unpinned: ["secret-procedure"],
      }),
    });
    const result = await handler(
      { version: "skl_v1", query: "review" },
      makeCTX(),
    );
    expect(result).toEqual({
      version: "skl_v1",
      repositoryCommitSha: currentSha,
      results: [],
      tokenCost: 0,
      withheld: {
        count: 2,
        reasons: { out_of_scope: 1, unapproved_digest: 1 },
      },
    });
    expect(skillSearchSummarize.output.parse(result)).toEqual(result);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("secret-procedure");
    expect(wire).not.toContain("review");
    expect(gate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner" }),
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
  });

  it("refuses a denied actor before reading any skill bytes", async () => {
    const catalog = vi.fn();
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    const handler = createSkillSearchSummarizeHandler({
      store: { list: vi.fn().mockResolvedValue([snapshot]), publish: vi.fn() },
      repository: vi.fn().mockResolvedValue(repository),
      catalog,
    });
    await expect(
      handler({ version: "skl_v1", query: "review" }, makeCTX()),
    ).rejects.toThrow("denied");
    expect(catalog).not.toHaveBeenCalled();
  });
});
