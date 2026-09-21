import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { createSkillConfigService } from "./skill-config.service";
import type {
  SkillConfigStore,
  SkillScope,
  NewSkillConfig,
} from "./skill-config.store";

const scope = { orgId: "org", workspaceId: "workspace" };
const sha = "a".repeat(40);
function setup() {
  const github = {
    getBranch: vi.fn().mockResolvedValue({ name: "release", sha }),
    getFileContent: vi.fn().mockResolvedValue("enabled = true"),
    getPullRequest: vi.fn().mockResolvedValue({
      merged: true,
      mergeCommitSha: sha,
      mergedAt: "2026-09-20T10:00:00.000Z",
      baseRef: "release",
    }),
    createBranch: vi.fn().mockResolvedValue({}),
    putFile: vi.fn().mockResolvedValue({}),
    openPullRequest: vi.fn().mockResolvedValue({
      number: 12,
      htmlUrl: "https://github.test/pull/12",
    }),
  };
  const store = {
    list: vi.fn(),
    publish: vi.fn(async (_scope: SkillScope, value: NewSkillConfig) => ({
      ...value,
      id: "skv_1",
      version: "skl_v1",
    })),
  };
  const repository = vi.fn().mockResolvedValue({
    bindingId: "binding",
    owner: "owner",
    repo: "repo",
    fullName: "owner/repo",
    productionBranch: "release",
    github: github as unknown as GitHubClient,
  });
  return {
    github,
    store,
    repository,
    service: createSkillConfigService({
      repository,
      store: store as SkillConfigStore,
      now: () => new Date("2026-09-20T09:00:00.000Z"),
    }),
  };
}
describe("skill configuration publication", () => {
  it("proposes only valid configuration against the binding's approved branch", async () => {
    const { service, github, repository, store } = setup();
    await expect(
      service.propose(scope, 'unbound_repo = "allow"'),
    ).rejects.toThrow();
    expect(repository).not.toHaveBeenCalled();
    expect(await service.propose(scope, "enabled = true")).toEqual({
      number: 12,
      url: "https://github.test/pull/12",
    });
    expect(github.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBranch: "release",
        branch: expect.stringMatching(/^oxagen\/skills-config-/),
      }),
    );
    expect(github.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".oxagen/skills.toml",
        content: "enabled = true",
      }),
    );
    expect(github.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release" }),
    );
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("reads back the immutable merged commit, never the PR head or a moving branch", async () => {
    const { service, github, store } = setup();
    const result = await service.publish(scope, 12);
    expect(github.getFileContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: ".oxagen/skills.toml",
      ref: sha,
    });
    expect(store.publish).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        repositoryBindingId: "binding",
        commitSha: sha,
        pullRequestNumber: 12,
        publishedAt: "2026-09-20T10:00:00.000Z",
        config: expect.objectContaining({ enabled: true }),
      }),
    );
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it("accepts an unrelated production commit only when its configuration bytes still match", async () => {
    const { service, github, store } = setup();
    const current = "b".repeat(40);
    github.getBranch.mockResolvedValue({ name: "release", sha: current });
    await service.publish(scope, 12);
    expect(
      github.getFileContent.mock.calls.map(([input]) => input.ref),
    ).toEqual([sha, current]);
    expect(store.publish).toHaveBeenCalledOnce();
  });
  it.each(["enabled = false", null])(
    "refuses a superseded or removed configuration: %s",
    async (currentFile) => {
      const { service, github, store } = setup();
      github.getBranch.mockResolvedValue({
        name: "release",
        sha: "b".repeat(40),
      });
      github.getFileContent
        .mockResolvedValueOnce("enabled = true")
        .mockResolvedValueOnce(currentFile);
      await expect(service.publish(scope, 12)).rejects.toMatchObject({
        reason: "skill_config_superseded",
      });
      expect(store.publish).not.toHaveBeenCalled();
    },
  );
  it("refuses publication after the approved branch was deleted", async () => {
    const { service, github, store } = setup();
    github.getBranch.mockResolvedValue(null);
    await expect(service.publish(scope, 12)).rejects.toMatchObject({
      reason: "skill_production_branch_missing",
    });
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("refuses a production branch change during publication", async () => {
    const { service, github, store } = setup();
    github.getBranch
      .mockResolvedValueOnce({ name: "release", sha })
      .mockResolvedValueOnce({ name: "release", sha: "b".repeat(40) });
    await expect(service.publish(scope, 12)).rejects.toMatchObject({
      reason: "skill_config_superseded",
    });
    expect(store.publish).not.toHaveBeenCalled();
  });
  it.each([
    {
      merged: false,
      baseRef: "release",
      mergeCommitSha: sha,
      mergedAt: "2026-09-20T10:00:00.000Z",
    },
    {
      merged: true,
      baseRef: "main",
      mergeCommitSha: sha,
      mergedAt: "2026-09-20T10:00:00.000Z",
    },
    {
      merged: true,
      baseRef: "release",
      mergeCommitSha: null,
      mergedAt: "2026-09-20T10:00:00.000Z",
    },
  ])("refuses a PR without approved merge provenance: %j", async (pr) => {
    const { service, github, store } = setup();
    github.getPullRequest.mockResolvedValue(pr);
    await expect(service.publish(scope, 12)).rejects.toMatchObject({
      reason: "skill_config_not_merged",
    });
    expect(github.getFileContent).not.toHaveBeenCalled();
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("imports absent configuration as off, but refuses malformed merged bytes", async () => {
    const { service, github, store } = setup();
    github.getFileContent.mockResolvedValue(null);
    expect(await service.publish(scope)).toMatchObject({
      pullRequestNumber: null,
      config: { enabled: false },
    });
    store.publish.mockClear();
    github.getFileContent.mockResolvedValue("enabled = ???");
    await expect(service.publish(scope, 12)).rejects.toThrow();
    expect(store.publish).not.toHaveBeenCalled();
  });
});
