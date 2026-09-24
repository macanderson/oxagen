import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { createSkillRepositoryResolver } from "./skill-config.repository";

describe("skill repository resolution", () => {
  const scope = { orgId: "org", workspaceId: "workspace" };
  const bound = {
    bindingId: "binding",
    provider: "github",
    connectionId: "approved-connection",
    repositoryId: "123",
    owner: "owner",
    repo: "repo",
    fullName: "owner/repo",
    productionBranch: "release",
  };
  it("uses the approved branch even if GitHub's default changes", async () => {
    const github = {
      getRepoInfo: vi
        .fn()
        .mockResolvedValue({ id: "123", defaultBranch: "main" }),
    } as unknown as GitHubClient;
    const token = vi.fn().mockResolvedValue("token");
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue(bound),
      token,
      client: () => github,
    });
    expect(await resolve(scope)).toMatchObject({
      productionBranch: "release",
      bindingId: "binding",
    });
    expect(token).toHaveBeenCalledWith({
      ...scope,
      connectionId: "approved-connection",
    });
  });
  it("does not mint a token for an unbound workspace", async () => {
    const token = vi.fn();
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue(undefined),
      token,
      client: vi.fn(),
    });
    await expect(resolve(scope)).rejects.toMatchObject({
      reason: "skill_repository_unbound",
    });
    expect(token).not.toHaveBeenCalled();
  });
  it("refuses a replacement repository under the approved name", async () => {
    const github = {
      getRepoInfo: vi.fn().mockResolvedValue({ id: "456" }),
    } as unknown as GitHubClient;
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue(bound),
      token: vi.fn().mockResolvedValue("token"),
      client: () => github,
    });
    await expect(resolve(scope)).rejects.toMatchObject({
      reason: "skill_repository_identity_changed",
    });
  });
  it("refuses a GitLab main project by name, before minting any token (#3762)", async () => {
    const token = vi.fn();
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue({
        ...bound,
        provider: "gitlab",
        fullName: "acme/platform/rules",
      }),
      token,
      client: vi.fn(),
    });
    await expect(resolve(scope)).rejects.toMatchObject({
      reason: "repository_host_unsupported",
    });
    expect(token).not.toHaveBeenCalled();
  });
});
