// The Organization writes through the real kernel seam: the viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran — ok, invalid (refused
// before the kernel) and denied (INV-19). Every guard has its negative: the
// scope this module checks itself, and the contract fields kernelWrite
// pre-parses before any capability runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  archiveWorkspace,
  createRole,
  createWorkspace,
  deleteRole,
  renameWorkspace,
  setRolePermissions,
} = await import("./actions");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
});

/**
 * The CapabilityContext an organization-level write reaches the kernel with:
 * the org-only workspace sentinel, because an OrgCtx names no workspace.
 */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: "00000000-0000-0000-0000-000000000000",
  surface: "app",
};

const role = {
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
  createdBy: "Priya Natarajan",
};

const draft = {
  name: "agent.release",
  description: " ",
  scope: "workspace",
  permissions: ["run.read"],
};

const denied = (name: string) =>
  new kernel.CapabilityError(name, "authz_denied", "denied");

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("createRole", () => {
  it("creates the role for the organization viewer and reports the row", async () => {
    invoke.mockResolvedValue({ role });
    expect(await createRole("acme", draft)).toEqual({
      ok: true,
      value: { id: role.id, name: role.name },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "create_role",
      {
        name: "agent.release",
        scopeKind: "workspace",
        // A description of only whitespace is stored as none.
        description: null,
        permissions: ["run.read"],
      },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a scope outside the contract's two before the kernel runs (negative)", async () => {
    expect(await createRole("acme", { ...draft, scope: "everything" })).toEqual(
      {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "scopeKind",
      },
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a role that grants nothing before the kernel runs (negative)", async () => {
    expect(await createRole("acme", { ...draft, permissions: [] })).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "permissions",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("carries the handler's refusal to the caller (negative)", async () => {
    invoke.mockRejectedValue(denied("create_role"));
    expect(await createRole("acme", draft)).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("setRolePermissions", () => {
  it("replaces the role's permissions", async () => {
    invoke.mockResolvedValue({ role });
    expect(
      await setRolePermissions("acme", "rol_7k2m9q4x8r1t5v3w6y0z2a", [
        "run.read",
      ]),
    ).toEqual({ ok: true, value: { id: role.id, name: role.name } });
    expect(invoke).toHaveBeenCalledWith(
      "set_role_grants",
      { roleId: "rol_7k2m9q4x8r1t5v3w6y0z2a", permissions: ["run.read"] },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a role's before the kernel runs (negative)", async () => {
    expect(await setRolePermissions("acme", "wrk_1", ["run.read"])).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "roleId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an empty permission set before the kernel runs (negative)", async () => {
    expect(
      await setRolePermissions("acme", "rol_7k2m9q4x8r1t5v3w6y0z2a", []),
    ).toMatchObject({ ok: false, reason: "invalid", field: "permissions" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("deleteRole", () => {
  it("deletes the role and reports what went", async () => {
    invoke.mockResolvedValue({ id: role.id, name: role.name });
    expect(await deleteRole("acme", role.id)).toEqual({
      ok: true,
      value: { id: role.id, name: role.name },
    });
    expect(invoke).toHaveBeenCalledWith(
      "delete_role",
      { roleId: role.id },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a role's before the kernel runs (negative)", async () => {
    expect(await deleteRole("acme", "")).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "roleId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("createWorkspace", () => {
  it("creates the workspace and reports its slug", async () => {
    invoke.mockResolvedValue({
      publicId: "wrk_1",
      name: "Research",
      slug: "research",
      orgSlug: "acme",
      createdAt: "2026-09-15T00:00:00.000Z",
    });
    expect(
      await createWorkspace("acme", { name: " Research ", slug: "research" }),
    ).toEqual({ ok: true, value: { slug: "research" } });
    expect(invoke).toHaveBeenCalledWith(
      "create_workspace",
      { name: "Research", slug: "research" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a slug the contract's shape rejects before the kernel runs (negative)", async () => {
    expect(
      await createWorkspace("acme", { name: "Research", slug: "Research Lab" }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "slug" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("carries a slug already taken to the caller as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "slug_taken",
        message: "taken",
      }),
    );
    expect(
      await createWorkspace("acme", { name: "Research", slug: "research" }),
    ).toEqual({ ok: false, reason: "conflict", code: "slug_taken" });
  });
});

describe("renameWorkspace", () => {
  it("renames and re-slugs the workspace the section names", async () => {
    invoke.mockResolvedValue({
      name: "Research",
      slug: "research",
      description: null,
      avatarUrl: null,
      consequenceRoles: {},
    });
    expect(
      await renameWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
      }),
    ).toEqual({ ok: true, value: { slug: "research" } });
    expect(invoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      { workspaceId: "wrk_1", name: "Research", slug: "research" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a workspace's before the kernel runs (negative)", async () => {
    expect(
      await renameWorkspace("acme", "rol_1", {
        name: "Research",
        slug: "research",
      }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "workspaceId" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("archiveWorkspace", () => {
  it("archives the workspace and reports when", async () => {
    invoke.mockResolvedValue({
      id: "wrk_1",
      slug: "research",
      name: "Research",
      archivedAt: "2026-09-15T10:00:00.000Z",
    });
    expect(await archiveWorkspace("acme", "wrk_1")).toEqual({
      ok: true,
      value: { archivedAt: "2026-09-15T10:00:00.000Z" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "archive_workspace",
      { workspaceId: "wrk_1" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a workspace's before the kernel runs (negative)", async () => {
    expect(await archiveWorkspace("acme", "")).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "workspaceId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("carries a workspace that still has agents to the caller as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "workspace_has_agents",
        message: "agents",
      }),
    );
    expect(await archiveWorkspace("acme", "wrk_1")).toEqual({
      ok: false,
      reason: "conflict",
      code: "workspace_has_agents",
    });
  });
});
