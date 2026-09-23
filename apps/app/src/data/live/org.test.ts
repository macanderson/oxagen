// The organization port: one kernel read each of list_members at org scope for
// the Organization page, list_iam_roles for the roles and the permission
// catalogue, list_workspaces for the Workspaces section and list_api_keys for
// the API keys page, each mapped into its view model, with a refusal passed
// through and an unmappable answer reported once. The keys are read
// through a WsCtx: a key names a workspace (ADR-073).
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
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
