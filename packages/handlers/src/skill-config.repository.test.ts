import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";

const mocks = vi.hoisted(() => ({ mintSteeringInstallationToken: vi.fn() }));
vi.mock("./lib/steering-app", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/steering-app")>();
  return {
    ...real,
    mintSteeringInstallationToken: mocks.mintSteeringInstallationToken,
  };
});

import { createSkillRepositoryResolver } from "./skill-config.repository";

beforeEach(() => {
  mocks.mintSteeringInstallationToken.mockReset();
  mocks.mintSteeringInstallationToken.mockResolvedValue("steering-tok");
});

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
    connectorId: "github",
    deliveryConfig: { installationId: "555" },
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

describe("skill repository resolution for a steering repository", () => {
  const scope = { orgId: "org", workspaceId: "workspace" };
  const steering = {
    bindingId: "binding",
    provider: "github",
    connectionId: "steering-connection",
    repositoryId: "123",
    owner: "acme",
    repo: "acme-steering",
    fullName: "acme/acme-steering",
    productionBranch: "main",
    connectorId: "github_steering",
    deliveryConfig: { installationId: 4242, owner: "acme" },
  };
  function fakeGithub() {
    return {
      getRepoInfo: vi.fn().mockResolvedValue({ id: "123" }),
    } as unknown as GitHubClient;
  }

  it("mints the Oxagen GitHub App token and never asks for the workspace's", async () => {
    const github = fakeGithub();
    const token = vi.fn().mockResolvedValue("workspace-tok");
    const client = vi.fn(() => github);
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue(steering),
      token,
      client,
    });
    // The connection's delivery config stays inside the resolver.
    expect(await resolve(scope)).toEqual({
      bindingId: "binding",
      owner: "acme",
      repo: "acme-steering",
      fullName: "acme/acme-steering",
      productionBranch: "main",
      github,
    });
    expect(mocks.mintSteeringInstallationToken).toHaveBeenCalledWith(4242);
    expect(client).toHaveBeenCalledWith("steering-tok");
    expect(token).not.toHaveBeenCalled();
  });

  it("reads an installation id stored as a string of digits", async () => {
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue({
        ...steering,
        deliveryConfig: { installationId: "4242" },
      }),
      token: vi.fn(),
      client: () => fakeGithub(),
    });
    await resolve(scope);
    expect(mocks.mintSteeringInstallationToken).toHaveBeenCalledWith(4242);
  });

  it("uses the workspace's token for a head on the workspace's own GitHub connection", async () => {
    const token = vi.fn().mockResolvedValue("workspace-tok");
    const client = vi.fn(() => fakeGithub());
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue({
        ...steering,
        connectionId: "workspace-connection",
        connectorId: "github",
      }),
      token,
      client,
    });
    await resolve(scope);
    expect(token).toHaveBeenCalledWith({
      ...scope,
      connectionId: "workspace-connection",
    });
    expect(client).toHaveBeenCalledWith("workspace-tok");
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
  });

  it.each([
    ["no delivery config", null],
    ["no installation id", { owner: "acme" }],
    ["a zero installation id", { installationId: 0 }],
    ["an installation id that is not a number", { installationId: "abc" }],
  ])("refuses a steering head with %s", async (_label, deliveryConfig) => {
    const token = vi.fn();
    const client = vi.fn();
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue({ ...steering, deliveryConfig }),
      token,
      client,
    });
    await expect(resolve(scope)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_installation_missing",
    });
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it("refuses a provisioned GitLab steering project by name, before reading any token", async () => {
    // Skill configuration writes through a GitHub client, and a GitLab group
    // access token cannot produce one.
    const token = vi.fn();
    const resolve = createSkillRepositoryResolver({
      binding: vi.fn().mockResolvedValue({
        ...steering,
        provider: "gitlab",
        fullName: "acme/platform/rules",
        connectorId: "gitlab_steering",
        deliveryConfig: { groupId: 77, groupPath: "acme" },
      }),
      token,
      client: vi.fn(),
    });
    await expect(resolve(scope)).rejects.toMatchObject({
      reason: "repository_host_unsupported",
    });
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });
});
