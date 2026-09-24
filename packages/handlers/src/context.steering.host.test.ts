// Which host a workspace's steering reads through (#3762). The provider comes
// from the workspace's MAIN head, read without the connection, so a GitLab
// head whose connection was retired still names GitLab and is refused there,
// never sent to the GitHub reader's legacy fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  heads: [] as { provider: string }[],
  readGitHub: vi.fn(),
  readGitLab: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async (fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => mocks.heads }),
        }),
      }),
    });
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("./context.steering.github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.github")>()),
  readGitHubConnection: mocks.readGitHub,
}));
vi.mock("./context.steering.gitlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.gitlab")>()),
  readGitLabConnection: mocks.readGitLab,
}));

import {
  readMainRepositoryProvider,
  readSteeringConnection,
} from "./context.steering.host";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.heads = [];
});

describe("readMainRepositoryProvider", () => {
  it("answers null with no main head, and the head's host otherwise", async () => {
    await expect(readMainRepositoryProvider(SCOPE)).resolves.toBeNull();
    mocks.heads = [{ provider: "gitlab" }];
    await expect(readMainRepositoryProvider(SCOPE)).resolves.toBe("gitlab");
    mocks.heads = [{ provider: "github" }];
    await expect(readMainRepositoryProvider(SCOPE)).resolves.toBe("github");
  });
});

describe("readSteeringConnection", () => {
  it("answers a GitLab binding with its host", async () => {
    mocks.heads = [{ provider: "gitlab" }];
    mocks.readGitLab.mockResolvedValue({
      connectionId: "c",
      projectId: "4242",
      owner: "acme/platform",
      repo: "rules",
      approvedFullName: "acme/platform/rules",
      approvedDefaultRef: "main",
    });
    await expect(readSteeringConnection(SCOPE)).resolves.toEqual({
      provider: "gitlab",
      source: "binding",
      owner: "acme/platform",
      repo: "rules",
      approvedFullName: "acme/platform/rules",
      approvedDefaultRef: "main",
    });
    expect(mocks.readGitHub).not.toHaveBeenCalled();
  });

  it("answers null for a GitLab head whose connection is retired, never the GitHub fallback", async () => {
    mocks.heads = [{ provider: "gitlab" }];
    mocks.readGitLab.mockResolvedValue(null);
    mocks.readGitHub.mockResolvedValue({
      source: "legacy_delivery_config",
      owner: "acme",
      repo: "unrelated",
    });
    await expect(readSteeringConnection(SCOPE)).resolves.toBeNull();
    expect(mocks.readGitHub).not.toHaveBeenCalled();
  });

  it("reads GitHub, legacy fallback included, when no GitLab head exists", async () => {
    mocks.readGitHub.mockResolvedValue({
      source: "legacy_delivery_config",
      owner: "acme",
      repo: "platform",
    });
    await expect(readSteeringConnection(SCOPE)).resolves.toMatchObject({
      provider: "github",
      source: "legacy_delivery_config",
    });
    expect(mocks.readGitLab).not.toHaveBeenCalled();
  });
});
