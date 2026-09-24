// attach_gitlab_project (#3762): what it proves about a token before it stores
// anything, what it stores, how a rotation keeps the webhook, and that no
// refusal or output carries the token.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { GitLabApiError, type GitLabClient } from "@oxagen/gitlab";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  findConnection: vi.fn(),
  resolveCredential: vi.fn(),
  refuseRole: false,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async () => {
    if (mocks.refuseRole)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Owner";
  },
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));
vi.mock("./repository.gitlab-connection", () => ({
  findWorkspaceGitLabConnection: mocks.findConnection,
}));
vi.mock("./lib/gitlab-credential", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/gitlab-credential")>();
  return { ...real, resolveGitLabCredential: mocks.resolveCredential };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schema } from "@oxagen/database";
import {
  createGitLabAttachHandler,
  type GitLabAttachDeps,
} from "./repository.gitlab.attach";
import { FakeGitLabApi } from "./context.steering.gitlab.test-support";

const TOKEN = "glpat-abcdefghijklmnopqrstuvwxyz";
const INPUT = { projectPath: "acme/platform/rules", token: TOKEN };

interface Writes {
  inserts: { table: unknown; values: Record<string, unknown> }[];
  updates: { table: unknown; values: Record<string, unknown> }[];
}

function wireDb(): Writes {
  const writes: Writes = { inserts: [], updates: [] };
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.inserts.push({ table, values });
        const done = Promise.resolve([]);
        return Object.assign(done, {
          returning: async () => [{ id: "conn-uuid", publicId: "con_gl1" }],
        });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.updates.push({ table, values });
        return { where: async () => [] };
      },
    }),
  };
  mocks.withTenantDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn(tx),
  );
  return writes;
}

function deps(api: FakeGitLabApi, over: Partial<GitLabClient> = {}) {
  const seal = vi.fn(async (plaintext: string) => ({
    keyId: "local:test",
    ciphertext: Buffer.from(`sealed:${plaintext.length}`).toString("base64"),
  }));
  const d: GitLabAttachDeps = {
    client: (token) => ({ ...api.client(token), ...over }),
    seal,
    newSecret: () => "whsec-fresh",
    webhookUrl: (id) => `https://api.oxagen.test/webhooks/gitlab/${id}`,
  };
  return { d, seal };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refuseRole = false;
  mocks.findConnection.mockResolvedValue(null);
});

describe("attach_gitlab_project", () => {
  it("stores the token and a webhook secret sealed together, and registers the hook", async () => {
    const writes = wireDb();
    const api = new FakeGitLabApi();
    const { d, seal } = deps(api);

    const out = await createGitLabAttachHandler(d)(INPUT, makeCTX());

    expect(out).toEqual({
      connectionId: "con_gl1",
      projectId: "4242",
      fullName: "acme/platform/rules",
      defaultRef: "main",
      tokenExpiresAt: "2027-09-23",
      rotated: false,
      webhook: { status: "registered" },
    });
    expect(seal).toHaveBeenCalledWith(
      JSON.stringify({ token: TOKEN, webhookSecret: "whsec-fresh" }),
    );
    const connection = writes.inserts.find(
      (w) => w.table === schema.sourceConnections,
    )!;
    expect(connection.values).toMatchObject({
      connectorId: "gitlab",
      authScheme: "project_access_token",
      status: "connected",
      deliveryConfig: {
        projectId: "4242",
        projectPath: "acme/platform/rules",
        webhookId: null,
      },
    });
    const credential = writes.inserts.find(
      (w) => w.table === schema.authCredentials,
    )!;
    expect(JSON.stringify(credential.values)).not.toContain(TOKEN);
    expect(
      writes.updates.some(
        (u) =>
          (u.values.deliveryConfig as { webhookId?: number })?.webhookId ===
          901,
      ),
    ).toBe(true);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("rotates the token on an existing connection and keeps its webhook and secret", async () => {
    const writes = wireDb();
    mocks.findConnection.mockResolvedValue({
      id: "conn-uuid",
      publicId: "con_gl1",
      status: "error",
      config: {
        projectId: "4242",
        projectPath: "acme/platform/rules",
        webhookId: 55,
      },
    });
    mocks.resolveCredential.mockResolvedValue({
      token: "glpat-old",
      webhookSecret: "whsec-kept",
    });
    const api = new FakeGitLabApi();
    const createProjectHook = vi.fn();
    const { d, seal } = deps(api, { createProjectHook });

    const out = await createGitLabAttachHandler(d)(INPUT, makeCTX());

    expect(out).toMatchObject({
      rotated: true,
      webhook: { status: "unchanged" },
    });
    expect(seal).toHaveBeenCalledWith(
      JSON.stringify({ token: TOKEN, webhookSecret: "whsec-kept" }),
    );
    expect(writes.inserts).toHaveLength(0);
    expect(
      writes.updates.find((u) => u.table === schema.sourceConnections)?.values,
    ).toMatchObject({ status: "connected", errorMessage: null });
    expect(createProjectHook).not.toHaveBeenCalled();
  });

  it("re-registers the hook with a new secret when the stored credential is unreadable", async () => {
    const writes = wireDb();
    mocks.findConnection.mockResolvedValue({
      id: "conn-uuid",
      publicId: "con_gl1",
      status: "error",
      config: {
        projectId: "4242",
        projectPath: "acme/platform/rules",
        webhookId: 55,
      },
    });
    const { gitlabNotConnected } = await import("./lib/gitlab-credential");
    mocks.resolveCredential.mockRejectedValue(gitlabNotConnected());
    const deleteProjectHook = vi.fn(async () => {});
    const createProjectHook = vi.fn(async () => ({ id: 902, url: "u" }));
    const { d, seal } = deps(new FakeGitLabApi(), {
      deleteProjectHook,
      createProjectHook,
    });

    const out = await createGitLabAttachHandler(d)(INPUT, makeCTX());

    // Never "unchanged" with a secret the old hook does not carry.
    expect(out).toMatchObject({
      rotated: true,
      webhook: { status: "registered" },
    });
    expect(seal).toHaveBeenCalledWith(
      JSON.stringify({ token: TOKEN, webhookSecret: "whsec-fresh" }),
    );
    expect(deleteProjectHook).toHaveBeenCalledWith({
      project: "4242",
      hookId: 55,
    });
    expect(createProjectHook).toHaveBeenCalledWith(
      expect.objectContaining({ token: "whsec-fresh" }),
    );
    expect(
      writes.updates.some(
        (u) =>
          (u.values.deliveryConfig as { webhookId?: number })?.webhookId ===
          902,
      ),
    ).toBe(true);
  });

  it("fails the rotation rather than guessing when the stored credential cannot be read for another reason", async () => {
    const writes = wireDb();
    mocks.findConnection.mockResolvedValue({
      id: "conn-uuid",
      publicId: "con_gl1",
      status: "connected",
      config: {
        projectId: "4242",
        projectPath: "acme/platform/rules",
        webhookId: 55,
      },
    });
    mocks.resolveCredential.mockRejectedValue(new Error("KMS unavailable"));
    const { d, seal } = deps(new FakeGitLabApi());
    await expect(
      createGitLabAttachHandler(d)(INPUT, makeCTX()),
    ).rejects.toThrow("KMS unavailable");
    expect(seal).not.toHaveBeenCalled();
    expect(writes.updates).toHaveLength(0);
  });

  it("connects without a webhook when the token's role cannot manage hooks", async () => {
    wireDb();
    const { d } = deps(new FakeGitLabApi(), {
      createProjectHook: async () => {
        throw new GitLabApiError(403, "403 Forbidden");
      },
    });
    await expect(
      createGitLabAttachHandler(d)(INPUT, makeCTX()),
    ).resolves.toMatchObject({ webhook: { status: "refused" } });
  });

  const refusals: [string, Partial<GitLabClient>, string][] = [
    [
      "a token GitLab does not accept",
      {
        getCurrentToken: async () => {
          throw new GitLabApiError(401, `401 Unauthorized ${TOKEN}`);
        },
      },
      "gitlab_token_invalid",
    ],
    [
      "a revoked token",
      {
        getCurrentToken: async () => ({
          id: 1,
          name: "t",
          scopes: ["api"],
          active: false,
          revoked: true,
          expiresAt: null,
        }),
      },
      "gitlab_token_invalid",
    ],
    [
      "a token without the api scope",
      {
        getCurrentToken: async () => ({
          id: 1,
          name: "t",
          scopes: ["read_repository"],
          active: true,
          revoked: false,
          expiresAt: null,
        }),
      },
      "gitlab_token_scope",
    ],
    [
      "a token with an administrative scope",
      {
        getCurrentToken: async () => ({
          id: 1,
          name: "t",
          scopes: ["api", "sudo"],
          active: true,
          revoked: false,
          expiresAt: null,
        }),
      },
      "gitlab_token_scope",
    ],
    [
      "a personal access token",
      {
        getCurrentUser: async () => ({ id: 3, username: "marcus", bot: false }),
      },
      "gitlab_token_not_project_scoped",
    ],
    [
      "a group access token",
      {
        getCurrentUser: async () => ({
          id: 3,
          username: "group_17_bot_abc",
          bot: true,
        }),
      },
      "gitlab_token_not_project_scoped",
    ],
    [
      "another project's access token",
      {
        getCurrentUser: async () => ({
          id: 3,
          username: "project_9999_bot_abc",
          bot: true,
        }),
      },
      "gitlab_token_not_project_scoped",
    ],
    [
      "a project the token cannot see",
      {
        getProject: async () => {
          throw new GitLabApiError(404, "404 Project Not Found");
        },
      },
      "repository_not_found",
    ],
  ];

  it.each(refusals)(
    "refuses %s before storing anything, without echoing the token",
    async (_name, over, reason) => {
      const writes = wireDb();
      const { d, seal } = deps(new FakeGitLabApi(), over);
      const err = await createGitLabAttachHandler(d)(INPUT, makeCTX()).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ reason });
      expect((err as Error).message).not.toContain(TOKEN);
      expect(seal).not.toHaveBeenCalled();
      expect(writes.inserts).toHaveLength(0);
      expect(writes.updates).toHaveLength(0);
    },
  );

  it("refuses an archived project and one with no default branch", async () => {
    wireDb();
    const archived = new FakeGitLabApi();
    archived.project.archived = true;
    await expect(
      createGitLabAttachHandler(deps(archived).d)(INPUT, makeCTX()),
    ).rejects.toMatchObject({ reason: "repository_archived" });
    const empty = new FakeGitLabApi();
    (empty.project as { defaultBranch: string | null }).defaultBranch = null;
    await expect(
      createGitLabAttachHandler(deps(empty).d)(INPUT, makeCTX()),
    ).rejects.toMatchObject({ reason: "repository_empty" });
  });

  it("refuses a caller below org Owner or Admin before calling GitLab", async () => {
    mocks.refuseRole = true;
    const api = new FakeGitLabApi();
    await expect(
      createGitLabAttachHandler(deps(api).d)(INPUT, makeCTX()),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    expect(api.tokens).toEqual([]);
  });

  it("refuses a path GitLab would not accept", async () => {
    const api = new FakeGitLabApi();
    await expect(
      createGitLabAttachHandler(deps(api).d)(
        { projectPath: "acme/rules.git", token: TOKEN },
        makeCTX(),
      ),
    ).rejects.toMatchObject({ reason: "invalid_project_path" });
    expect(api.tokens).toEqual([]);
  });
});
