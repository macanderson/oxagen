// The organization port: one kernel read each of list_members at org scope for
// the Organization page, list_iam_roles for the roles and the permission
// catalogue, list_workspaces for the Workspaces section and list_api_keys for
// the API keys page, and list_repositories with list_agents for one
// workspace's row, each mapped into its view model, with a refusal passed
// through and an unmappable answer reported once. The keys and a workspace's
// facts are read through a WsCtx: a key names a workspace (ADR-073), and both
// facts reads are workspace-scoped.
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { org } = await import("./org");

const ORG_FIELDS = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
} as const;

const ctx = unsafeMint(OrgCtx, ORG_FIELDS);

/** The workspace scope the keys read runs in. */
const wsCtx = unsafeMint(WsCtx, {
  ...ORG_FIELDS,
  workspaceId: "7a000000-0000-4000-8000-0000000000c3",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const member = {
  id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  role: "Owner",
  joinedAt: "2026-03-02T09:15:00.000Z",
};
const invitation = {
  id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
  email: "dana.reyes@acme.example",
  role: "Admin",
  invitedAt: "2026-09-10T12:00:00.000Z",
  expiresAt: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("org.members", () => {
  it("reads list_members at org scope for the organization page and returns the People view model", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "org", members: [member], invitations: [invitation] }),
    );
    expect(await org.members(ctx)).toEqual(
      readOk({
        members: [{ ...member, role: "owner" }],
        invitations: [{ ...invitation, role: "admin" }],
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.members(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.members(ctx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a row the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        scope: "org",
        members: [{ ...member, role: "superuser" }],
        invitations: [],
      }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once when the kernel answers at workspace scope (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "workspace", members: [member] }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });
});

const roleRow = {
  id: "rol_7k2m9q4x8r1t5v3w6y0z2a",
  name: "agent.release",
  description: null,
  scopeKind: "workspace",
  kind: "agent",
  isSystemDefault: false,
  version: "1",
  memberCount: 0,
  grants: [{ capability: "list_runs", effect: "allow" }],
  permissions: ["run.read"],
  createdAt: "2026-09-15T00:00:00.000Z",
  createdBy: null,
};

const rolesOut = {
  roles: [roleRow],
  total: 1,
  hasMore: false,
  limit: 100,
  offset: 0,
  catalog: [
    {
      id: "run.read",
      group: "Runs",
      description: "Read runs, their approvals and the commands sent to them",
      capabilities: ["list_runs"],
    },
  ],
  enforcement: { tier: "free", enforced: false },
};

describe("org.roles", () => {
  it("reads list_iam_roles with its grants for the organization page and returns the catalogue view model", async () => {
    kernelRead.mockResolvedValue(readOk(rolesOut));
    expect(await org.roles(ctx)).toEqual(
      readOk({
        roles: [
          {
            id: roleRow.id,
            name: "agent.release",
            description: null,
            scope: "workspace",
            kind: "agent",
            builtIn: false,
            permissions: ["run.read"],
            heldBy: 0,
            createdBy: null,
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ],
        catalog: [
          {
            permission: "run.read",
            group: "Runs",
            description:
              "Read runs, their approvals and the commands sent to them",
            capabilities: ["list_runs"],
          },
        ],
        enforcement: { tier: "free", enforced: false },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: iamRoleList,
      // The bounds are sent: with neither, the read took the contract's 100
      // default and silently dropped every role past it (#3110).
      input: { includeGrants: true, limit: 200, offset: 0 },
      page: "organization",
    });
    expect(kernelRead).toHaveBeenCalledOnce();
    expect(captureError).not.toHaveBeenCalled();
  });

  // The Roles section is the organization's whole catalogue and has no paging
  // control, so a role on a later page is a role nobody can see, edit or
  // delete. The read walks the pages instead.
  it("walks every page and hands the section all of the roles", async () => {
    const second = { ...roleRow, id: "rol_2", name: "agent.deploy" };
    kernelRead
      .mockResolvedValueOnce(readOk({ ...rolesOut, hasMore: true, total: 2 }))
      .mockResolvedValueOnce(
        readOk({
          ...rolesOut,
          roles: [second],
          hasMore: false,
          total: 2,
          offset: 200,
        }),
      );
    const read = await org.roles(ctx);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected an ok read");
    expect(read.value.roles.map((r) => r.name)).toEqual([
      "agent.release",
      "agent.deploy",
    ]);
    expect(kernelRead).toHaveBeenNthCalledWith(2, ctx, {
      contract: iamRoleList,
      input: { includeGrants: true, limit: 200, offset: 200 },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a refusal on a later page through rather than showing a partial catalogue (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead
      .mockResolvedValueOnce(readOk({ ...rolesOut, hasMore: true, total: 2 }))
      .mockResolvedValueOnce(denied);
    expect(await org.roles(ctx)).toEqual(denied);
  });

  it("stops walking rather than looping for ever when hasMore never clears (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ ...rolesOut, hasMore: true }));
    const read = await org.roles(ctx);
    expect(read.ok).toBe(true);
    // The ceiling in org.ts: 40 pages, then it shows what it has.
    expect(kernelRead).toHaveBeenCalledTimes(40);
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.roles(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a role the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...rolesOut,
        roles: [{ ...roleRow, id: "7a000000-0000-4000-8000-0000000000a1" }],
      }),
    );
    expect(await org.roles(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });
});

const workspacesOut = {
  organization: {
    id: "7a000000-0000-4000-8000-0000000000a1",
    publicId: "org_1",
    slug: "acme",
    namespace: "acme",
    name: "Acme Robotics",
  },
  workspaces: [
    {
      id: "7b000000-0000-4000-8000-000000000001",
      publicId: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      slug: "core-platform",
      namespace: "core",
      name: "Core platform",
      role: "Owner",
      archivedAt: null,
      costCenter: null,
    },
  ],
};

describe("org.workspaces", () => {
  it("reads list_workspaces for the viewer's organization, archived rows included", async () => {
    kernelRead.mockResolvedValue(readOk(workspacesOut));
    expect(await org.workspaces(ctx)).toEqual(
      readOk({
        workspaces: [
          {
            id: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
            slug: "core-platform",
            namespace: "core",
            name: "Core platform",
            role: "Owner",
            archivedAt: null,
            costCenter: null,
          },
        ],
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: workspaceList,
      input: { orgSlug: "acme", includeArchived: true },
      page: "organization",
    });
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.workspaces(ctx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a row the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...workspacesOut,
        workspaces: [
          { ...workspacesOut.workspaces[0], publicId: "not-a-public-id" },
        ],
      }),
    );
    expect(await org.workspaces(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

const storedKey = {
  publicId: "aky_7k2m9q4x8r1t5v3w6y0z2a",
  name: "CI runner",
  prefix: "ox_liveliveli",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  rotatable: true,
};

/** One `list_repositories` row, as the contract's output carries it. */
function binding(
  role: "main" | "linked",
  fullName: string,
  defaultRef: string,
) {
  const [owner = "acme", name = "repo"] = fullName.split("/");
  return {
    bindingId: "rpb_0a1b2c",
    role,
    owner,
    name,
    fullName,
    defaultRef,
    htmlUrl: `https://github.com/${fullName}`,
    boundAt: "2026-09-01T00:00:00.000Z",
    connectionLive: true,
    events: "installed" as const,
  };
}

/** `list_agents`' answer: one row of the page and the totals over the workspace. */
function agents(identities: number) {
  return {
    items: [],
    nextCursor: null,
    totals: {
      identities,
      enrolled: 0,
      holdingMandate: null,
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  };
}

describe("org.workspaceFacts", () => {
  it("reads the repositories and the agent total inside the workspace and returns the row's facts", async () => {
    kernelRead.mockImplementation((_ctx, { contract }) =>
      Promise.resolve(
        contract === repositoryList
          ? readOk({
              repositories: [
                binding("main", "acme/platform", "main"),
                binding("linked", "acme/billing", "trunk"),
              ],
            })
          : readOk(agents(64)),
      ),
    );
    expect(await org.workspaceFacts(wsCtx)).toEqual(
      readOk({
        repositories: [
          { role: "main", fullName: "acme/platform", defaultRef: "main" },
          { role: "linked", fullName: "acme/billing", defaultRef: "trunk" },
        ],
        agents: 64,
        archiveBlockers: { count: 0, more: false },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: repositoryList,
      input: {},
      page: "organization",
    });
    // The largest page: the Archive dialog counts the rows it would refuse over.
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: agentList,
      input: { limit: 100 },
      page: "organization",
    });
  });

  it("counts the agents archive_workspace refuses over, leaving out the built-in and retired ones", async () => {
    kernelRead.mockImplementation((_ctx, { contract }) =>
      Promise.resolve(
        contract === repositoryList
          ? readOk({ repositories: [] })
          : readOk({
              ...agents(4),
              items: [
                { slug: "qa-chat", status: "unenrolled" },
                { slug: "old-bot", status: "retired" },
                { slug: "invoice-bot", status: "enrolled" },
                { slug: "review-bot", status: "suspended" },
              ],
              nextCursor: "cmV2aWV3LWJvdA",
            }),
      ),
    );
    const read = await org.workspaceFacts(wsCtx);
    expect(read.ok && read.value).toMatchObject({
      agents: 4,
      // Two live agents on this page, and the page did not reach the end.
      archiveBlockers: { count: 2, more: true },
    });
  });

  it("refuses the whole when either read refuses, never a row half fact and half gap (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "organization.read",
    } as const;
    kernelRead.mockImplementation((_ctx, { contract }) =>
      Promise.resolve(
        contract === agentList ? denied : readOk({ repositories: [] }),
      ),
    );
    expect(await org.workspaceFacts(wsCtx)).toEqual(denied);
  });

  it("answers record_unmappable for a negative agent total, reported once (negative)", async () => {
    kernelRead.mockImplementation((_ctx, { contract }) =>
      Promise.resolve(
        contract === repositoryList
          ? readOk({ repositories: [] })
          : readOk(agents(-1)),
      ),
    );
    expect(await org.workspaceFacts(wsCtx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("org.apiKeys", () => {
  it("reads list_api_keys in the workspace scope and returns the API keys view model", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [storedKey] }));
    expect(await org.apiKeys(wsCtx)).toEqual(
      readOk([
        {
          id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
          name: "CI runner",
          prefix: "ox_liveliveli",
          createdAt: "2026-09-13T10:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          rotatable: true,
        },
      ]),
    );
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: apiKeyList,
      input: {},
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("returns an empty list for a workspace holding no keys", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [] }));
    expect(await org.apiKeys(wsCtx)).toEqual(readOk([]));
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.apiKeys(wsCtx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.apiKeys(wsCtx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a key the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        items: [
          { ...storedKey, publicId: "7a000000-0000-4000-8000-0000000000a1" },
        ],
      }),
    );
    expect(await org.apiKeys(wsCtx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

/** A provider as list_sso_providers returns it, timestamps and scopes included. */
const storedProvider = {
  providerId: "acme-okta",
  displayName: "Acme Okta",
  protocol: "oidc",
  domain: "acme.com",
  domainVerified: false,
  issuer: "https://acme.okta.com",
  groupsClaim: "groups",
  domainVerification: {
    recordName: "_oxagen-sso.acme.com",
    recordValue: "oxagen-sso-verification=4f9d2c7a",
  },
  callbackUrl: "https://app.oxagen.sh/api/auth/sso/callback/acme-okta",
  spMetadataUrl: null,
  oidc: { clientId: "0oa1b2c3d4", clientSecretSet: true, scopes: [] },
  saml: null,
  groupRoles: [{ group: "oxagen-admins", role: "admin" }],
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
};

/** The SCIM part of list_sso_providers (#3734): the endpoint and the live token's prefix. */
const storedScim = {
  baseUrl: "https://app.oxagen.sh/api/scim/v2",
  token: {
    tokenPrefix: "oxscim_AbCdEfGh",
    createdAt: "2026-09-23T10:00:00.000Z",
    lastUsedAt: null,
  },
};

describe("org.dataPlane", () => {
  const shared = {
    kind: "postgres",
    mode: "shared",
    status: "active",
    host: null,
    database: null,
    schemaVersion: null,
    lastVerifiedAt: null,
    rotatedAt: null,
  };

  it("reads get_data_plane for the Postgres binding and returns the redacted view", async () => {
    kernelRead.mockResolvedValue(readOk(shared));
    expect(await org.dataPlane(ctx)).toEqual(
      readOk({
        mode: "shared",
        status: "active",
        host: null,
        database: null,
        schemaVersion: null,
        lastVerifiedAt: null,
        rotatedAt: null,
      }),
    );
    // The Postgres binding: the one every tenant table sits on.
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: orgDataPlaneGet,
      input: { kind: "postgres" },
      page: "organization",
    });
  });

  it("passes a refusal through unchanged and reports nothing (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "org.owner or org.admin",
    } as const;
    kernelRead.mockResolvedValue(denied);
    expect(await org.dataPlane(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a binding the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...shared, lastVerifiedAt: "last Tuesday" }),
    );
    expect(await org.dataPlane(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("org.sso", () => {
  it("reads list_sso_providers for the organization and returns the SSO view model", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        providers: [storedProvider],
        policy: { ssoRequired: true },
        entitled: true,
        scim: storedScim,
      }),
    );
    expect(await org.sso(ctx)).toEqual(
      readOk({
        providers: [
          {
            providerRef: "acme-okta",
            displayName: "Acme Okta",
            protocol: "oidc",
            domain: "acme.com",
            domainVerified: false,
            issuer: "https://acme.okta.com",
            groupsClaim: "groups",
            verification: {
              recordName: "_oxagen-sso.acme.com",
              recordValue: "oxagen-sso-verification=4f9d2c7a",
            },
            callbackUrl:
              "https://app.oxagen.sh/api/auth/sso/callback/acme-okta",
            spMetadataUrl: null,
            oidc: { clientRef: "0oa1b2c3d4", clientSecretSet: true },
            saml: null,
            groupRoles: [{ group: "oxagen-admins", role: "admin" }],
          },
        ],
        policy: { ssoRequired: true },
        entitled: true,
        scim: {
          baseUrl: "https://app.oxagen.sh/api/scim/v2",
          token: {
            prefix: "oxscim_AbCdEfGh",
            createdAt: "2026-09-23T10:00:00.000Z",
            lastUsedAt: null,
          },
        },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: orgSsoList,
      input: {},
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("carries a plan without SSO through, with the providers still listed", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        providers: [storedProvider],
        policy: { ssoRequired: false },
        entitled: false,
        scim: { ...storedScim, token: null },
      }),
    );
    const read = await org.sso(ctx);
    expect(read).toMatchObject({
      ok: true,
      value: {
        entitled: false,
        providers: [expect.objectContaining({ providerRef: "acme-okta" })],
      },
    });
  });

  it("passes a denied read through (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "list_sso_providers",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await org.sso(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a mapping to owner (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        providers: [
          {
            ...storedProvider,
            groupRoles: [{ group: "oxagen-admins", role: "owner" }],
          },
        ],
        policy: { ssoRequired: false },
        entitled: true,
        scim: storedScim,
      }),
    );
    expect(await org.sso(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });
});
