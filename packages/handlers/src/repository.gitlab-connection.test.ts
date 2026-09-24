// A workspace's GitLab project connections (#3762): which live connection a
// path or project id names, and the project read through its own token.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabApiError, type GitLabClient } from "@oxagen/gitlab";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  resolveCredential: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const run = async (fn: (t: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => mocks.rows }),
        }),
      }),
    });
  return { ...real, withTenantDb: run, withOrgDb: run };
});
vi.mock("./lib/gitlab-credential", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/gitlab-credential")>()),
  resolveGitLabCredential: mocks.resolveCredential,
}));

import {
  findWorkspaceGitLabConnection,
  gitlabDeliveryConfigOf,
  readGitLabProject,
} from "./repository.gitlab-connection";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const row = (id: string, projectId: string, projectPath: string) => ({
  id,
  publicId: `con_${id}`,
  status: "connected",
  deliveryConfig: { projectId, projectPath, webhookId: 9 },
});

beforeEach(() => {
  mocks.rows = [];
  mocks.resolveCredential.mockReset();
});

describe("gitlabDeliveryConfigOf", () => {
  it("reads a GitLab config and refuses anything else", () => {
    expect(
      gitlabDeliveryConfigOf({ projectId: "42", projectPath: "a/b" }),
    ).toEqual({ projectId: "42", projectPath: "a/b", webhookId: null });
    for (const bad of [
      null,
      "x",
      { installationId: "555" },
      { projectId: "042", projectPath: "a/b" },
      { projectId: "42", projectPath: "" },
    ])
      expect(gitlabDeliveryConfigOf(bad)).toBeNull();
  });
});

describe("findWorkspaceGitLabConnection", () => {
  it("matches a path case-insensitively, newest row first, past a malformed one", async () => {
    mocks.rows = [
      { ...row("bad", "1", "x/y"), deliveryConfig: { installationId: "5" } },
      row("new", "4242", "Acme/Platform/Rules"),
      row("old", "4242", "acme/platform/rules"),
    ];
    await expect(
      findWorkspaceGitLabConnection(SCOPE, { path: "acme/platform/rules" }),
    ).resolves.toMatchObject({ id: "new", config: { projectId: "4242" } });
  });

  it("matches by project id, and answers null when nothing matches", async () => {
    mocks.rows = [row("a", "7", "acme/other"), row("b", "4242", "acme/moved")];
    await expect(
      findWorkspaceGitLabConnection(SCOPE, { id: "4242" }),
    ).resolves.toMatchObject({ id: "b" });
    await expect(
      findWorkspaceGitLabConnection(SCOPE, { id: "9" }),
    ).resolves.toBeNull();
  });
});

describe("readGitLabProject", () => {
  const connection = {
    id: "c",
    publicId: "con_c",
    status: "connected",
    config: { projectId: "4242", projectPath: "acme/rules", webhookId: null },
  };
  const client = (getProject: GitLabClient["getProject"]) => () =>
    ({ getProject }) as unknown as GitLabClient;

  beforeEach(() => {
    mocks.resolveCredential.mockResolvedValue({
      token: "glpat-x",
      webhookSecret: "s",
    });
  });

  it("reads the project by id through the connection's token", async () => {
    const getProject = vi.fn(async () => ({
      id: "4242",
      pathWithNamespace: "acme/platform/rules",
      namespaceFullPath: "acme/platform",
      path: "rules",
      defaultBranch: "trunk",
      webUrl: "",
      archived: false,
    }));
    await expect(
      readGitLabProject(SCOPE, connection, client(getProject)),
    ).resolves.toEqual({
      id: "4242",
      owner: "acme/platform",
      name: "rules",
      fullName: "acme/platform/rules",
      defaultBranch: "trunk",
    });
    expect(getProject).toHaveBeenCalledWith("4242");
  });

  it("answers null for a project the token cannot see", async () => {
    await expect(
      readGitLabProject(
        SCOPE,
        connection,
        client(async () => {
          throw new GitLabApiError(404, "404 Project Not Found");
        }),
      ),
    ).resolves.toBeNull();
  });

  it("refuses a rejected token without naming it, and a project with no default branch", async () => {
    const rejected = await readGitLabProject(
      SCOPE,
      connection,
      client(async () => {
        throw new GitLabApiError(401, "401 Unauthorized");
      }),
    ).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ reason: "gitlab_credential_rejected" });
    expect((rejected as Error).message).not.toContain("glpat-x");
    await expect(
      readGitLabProject(
        SCOPE,
        connection,
        client(async () => ({
          id: "4242",
          pathWithNamespace: "acme/rules",
          namespaceFullPath: "acme",
          path: "rules",
          defaultBranch: null,
          webUrl: "",
          archived: false,
        })),
      ),
    ).rejects.toMatchObject({ reason: "repository_empty" });
  });
});
