// The organization port: one kernel read of list_members at org scope for the
// Organization page, mapped into the People view model, with a refusal passed
// through and an unmappable answer reported once.
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

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { org } = await import("./org");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
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
      input: { includeGrants: true },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
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
