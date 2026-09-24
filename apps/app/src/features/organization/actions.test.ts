// The Organization writes through the real kernel seam (INV-19): the viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what the person gets back and whether the capability ran — ok, invalid
// (refused before the kernel) and denied. Every guard has its negative: the
// scope this module checks itself, the role set the People writes check
// themselves, and the contract fields kernelWrite pre-parses before any
// capability runs. Every refusal is classified by the code the handler threw,
// never by its message (§3.2).
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
  changeMemberRole,
  createRole,
  createWorkspace,
  deleteRole,
  editWorkspace,
  removeOrgMember,
  sendInvitation,
  resendInvitation,
  revokeInvitation,
  setRolePermissions,
} = await import("./actions");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

/** The member id the roster prints, and the only id the page holds (INV-11). */
const MEMBER = "usr_7k2m9q4x8r1t5v3w6y0z2a";

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

const refusal = (
  code: "forbidden" | "not_found" | "conflict",
  reason: string,
) => new kernel.HandlerError({ code, reason, message: `${code}: ${reason}` });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(ctx);
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
  const CREATED = {
    publicId: "wrk_1",
    name: "Research",
    slug: "research",
    orgSlug: "acme",
    createdAt: "2026-09-15T00:00:00.000Z",
    mainRepo: {
      bindingId: "rpb_0a1b2c",
      connectionId: "con_01hq",
      fullName: "acme/research",
      defaultRef: "main",
    },
  };

  it("creates the workspace with its main repository and reports its slug", async () => {
    invoke.mockResolvedValue(CREATED);
    expect(
      await createWorkspace("acme", {
        name: " Research ",
        slug: "research",
        mainRepo: "acme/research",
      }),
    ).toEqual({ ok: true, value: { slug: "research" } });
    expect(invoke).toHaveBeenCalledWith(
      "create_workspace",
      {
        name: "Research",
        slug: "research",
        mainRepo: { provider: "github", owner: "acme", name: "research" },
      },
      expect.objectContaining(TENANT),
    );
  });

  // What a person pastes from GitHub: the clone URL's tail, with space around
  // it. Only the two segments reach the contract.
  it("drops surrounding space and a trailing .git from the repository", async () => {
    invoke.mockResolvedValue(CREATED);
    await createWorkspace("acme", {
      name: "Research",
      slug: "research",
      mainRepo: "  acme/research.git ",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      mainRepo: { owner: "acme", name: "research" },
    });
  });

  it.each(["", "research", "acme/research/extra", "/research", "acme/"])(
    "refuses %j as the main repository before the kernel runs (negative)",
    async (mainRepo) => {
      expect(
        await createWorkspace("acme", {
          name: "Research",
          slug: "research",
          mainRepo,
        }),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "repository_unparsable",
        field: "mainRepo",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  // The segments' spelling is the contract's to judge: `bind_main_repository`'s
  // GitHub-shaped owner and name schemas, carried by import.
  it("refuses an owner GitHub would not accept before the kernel runs, naming the field (negative)", async () => {
    expect(
      await createWorkspace("acme", {
        name: "Research",
        slug: "research",
        mainRepo: "-acme-/research",
      }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "mainRepo.owner" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a slug the contract's shape rejects before the kernel runs (negative)", async () => {
    expect(
      await createWorkspace("acme", {
        name: "Research",
        slug: "Research Lab",
        mainRepo: "acme/research",
      }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "slug" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("carries a slug already taken to the caller as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "slug_taken"));
    expect(
      await createWorkspace("acme", {
        name: "Research",
        slug: "research",
        mainRepo: "acme/research",
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "slug_taken" });
  });

  it("makes the slug from the name when the form sends none, as the design's form has no slug", async () => {
    invoke.mockResolvedValue(CREATED);
    await createWorkspace("acme", {
      name: "  Data Platform (EU) ",
      mainRepo: "acme/research",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      name: "Data Platform (EU)",
      slug: "data-platform-eu",
    });
  });

  it("names a slug the name made invalid on the Name field, which is the one the person can fix (negative)", async () => {
    // A one-letter name makes a slug the contract refuses as too short.
    expect(
      await createWorkspace("acme", { name: "X", mainRepo: "acme/research" }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "name" });
    expect(invoke).not.toHaveBeenCalled();
  });

  // The five repository refusals `create_workspace` documents, each carried
  // with its reason intact so the dialog can print its own sentence.
  it.each([
    ["conflict", "github_not_authorized"],
    ["not_found", "installation_unreachable"],
    ["not_found", "repository_not_installed"],
    ["conflict", "main_repo_claimed"],
    ["conflict", "repository_linked_elsewhere"],
  ] as const)(
    "carries a %s: %s from the handler to the caller (negative)",
    async (code, reason) => {
      invoke.mockRejectedValue(refusal(code, reason));
      expect(
        await createWorkspace("acme", {
          name: "Research",
          slug: "research",
          mainRepo: "acme/research",
        }),
      ).toEqual({ ok: false, reason: code, code: reason });
    },
  );
});

/** What `update_workspace_settings` answers, which the edit reads a slug off. */
const SETTINGS = {
  name: "Research",
  slug: "research",
  description: null,
  avatarUrl: null,
  consequenceRoles: {},
  steering: { autoSync: false, blockStaleRuns: false },
};

/** What `set_governance_mode` answers when it commits. */
const GOVERNANCE = {
  outcome: "applied" as const,
  requestedMode: "solo" as const,
  previousMode: "team" as const,
  effectiveMode: "solo" as const,
  fullName: "acme/research",
  productionBranch: "main",
  commitSha: "c0ffee1",
  pullRequest: null,
  overrodeReview: true,
};

describe("editWorkspace", () => {
  it("renames and re-slugs the workspace the section names", async () => {
    invoke.mockResolvedValue(SETTINGS);
    expect(
      await editWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
        mode: "",
        applyImmediately: false,
      }),
    ).toEqual({ ok: true, value: { slug: "research", governance: null } });
    // One capability, because no mode was picked: the governance half costs a
    // GitHub round trip and must not run on a plain rename.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "update_workspace_settings",
      { workspaceId: "wrk_1", name: "Research", slug: "research" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a workspace's before the kernel runs (negative)", async () => {
    expect(
      await editWorkspace("acme", "rol_1", {
        name: "Research",
        slug: "research",
        mode: "",
        applyImmediately: false,
      }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "workspaceId" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sets the governance mode after the rename, override and all", async () => {
    invoke.mockResolvedValueOnce(SETTINGS).mockResolvedValueOnce(GOVERNANCE);
    expect(
      await editWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
        mode: "solo",
        applyImmediately: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        slug: "research",
        governance: {
          ok: true,
          outcome: "applied",
          mode: "solo",
          repo: "acme/research",
          branch: "main",
          pullRequest: null,
          overrodeReview: true,
        },
      },
    });
    // The rename first, so a taken slug leaves the repository untouched.
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "update_workspace_settings",
      "set_governance_mode",
    ]);
    expect(invoke).toHaveBeenLastCalledWith(
      "set_governance_mode",
      { workspaceId: "wrk_1", mode: "solo", applyImmediately: true },
      expect.objectContaining(TENANT),
    );
  });

  it("never reaches the repository when the rename is refused (negative)", async () => {
    invoke.mockRejectedValueOnce(
      new kernel.HandlerError({ code: "conflict", reason: "slug_taken" }),
    );
    expect(
      await editWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
        mode: "solo",
        applyImmediately: false,
      }),
    ).toMatchObject({ ok: false, reason: "conflict", code: "slug_taken" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a refused governance change and still reports the rename", async () => {
    invoke.mockResolvedValueOnce(SETTINGS).mockRejectedValueOnce(
      new kernel.HandlerError({
        code: "conflict",
        reason: "github_not_connected",
      }),
    );
    // ok, not a refusal: the rename happened, and answering `denied` for the
    // whole edit would claim otherwise.
    expect(
      await editWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
        mode: "team",
        applyImmediately: false,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        slug: "research",
        governance: { ok: false, code: "github_not_connected" },
      },
    });
  });

  it("refuses an unknown mode without invoking governance (negative)", async () => {
    invoke.mockResolvedValue(SETTINGS);
    expect(
      await editWorkspace("acme", "wrk_1", {
        name: "Research",
        slug: "research",
        mode: "permissive",
        applyImmediately: false,
      }),
    ).toMatchObject({
      ok: true,
      value: { governance: { ok: false, reason: "invalid" } },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("archiveWorkspace", () => {
  it("archives the workspace and reports when", async () => {
    invoke.mockResolvedValue({
      id: "wrk_1",
      slug: "research",
      name: "Research",
      archivedAt: "2026-09-15T10:00:00.000Z",
      suspendedApiKeys: 0,
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
    invoke.mockRejectedValue(refusal("conflict", "workspace_has_agents"));
    expect(await archiveWorkspace("acme", "wrk_1")).toEqual({
      ok: false,
      reason: "conflict",
      code: "workspace_has_agents",
    });
  });
});

describe("changeMemberRole", () => {
  it("grants the role the picker named, under the IAM name the contract takes", async () => {
    invoke.mockResolvedValue({
      changed: true,
      targetUserId: MEMBER,
      orgId: ctx.orgId,
      previousRole: "member",
      newRole: "Admin",
    });
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: true,
      value: { role: "admin" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "change_member_role",
      { targetUserId: MEMBER, newRole: "Admin" },
      expect.objectContaining(TENANT),
    );
  });

  it.each(["member", "viewer", "", "Owner"])(
    "refuses %o, a role this organization does not grant, before the kernel runs (negative)",
    async (grant) => {
      expect(await changeMemberRole("acme", MEMBER, grant)).toEqual({
        ok: false,
        reason: "invalid",
        code: "role_not_grantable",
        field: "role",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty member id before the kernel runs (negative)", async () => {
    expect(await changeMemberRole("acme", "", "admin")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "targetUserId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a role the actor may not change as denied (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "insufficient_role"));
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "denied",
      code: "insufficient_role",
    });
  });

  it.each([
    ["a member of another organization", "target_not_member"],
    ["a role this organization never seeded", "role_not_found"],
  ])("returns %s as not_found (negative)", async (_what, reason) => {
    invoke.mockRejectedValue(refusal("not_found", reason));
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "not_found",
      code: reason,
    });
  });

  it("returns the last owner's demotion as conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "last_owner"));
    expect(await changeMemberRole("acme", MEMBER, "billing")).toEqual({
      ok: false,
      reason: "conflict",
      code: "last_owner",
    });
  });

  it("reports output the contract does not admit as unavailable (negative)", async () => {
    invoke.mockResolvedValue({ changed: true });
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });
});

describe("removeOrgMember", () => {
  it("removes the member the roster named", async () => {
    invoke.mockResolvedValue({
      removed: true,
      targetUserId: MEMBER,
      orgId: ctx.orgId,
    });
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: true,
      value: { memberId: MEMBER },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "remove_org_member",
      { targetUserId: MEMBER },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty member id before the kernel runs (negative)", async () => {
    expect(await removeOrgMember("acme", "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "targetUserId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a member who may not remove people as denied (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "insufficient_role"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "denied",
      code: "insufficient_role",
    });
  });

  it("returns a target outside this organization as not_found (negative)", async () => {
    invoke.mockRejectedValue(refusal("not_found", "target_not_member"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "not_found",
      code: "target_not_member",
    });
  });

  it("returns the last owner's removal as conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "last_owner"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "conflict",
      code: "last_owner",
    });
  });
});

describe("sendInvitation", () => {
  const invitation = {
    id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
    status: "pending",
    expires_at: "2026-09-27T12:00:00.000Z",
  };
  const draft = {
    email: " dana.reyes@acme.example ",
    role: "admin",
    message: " Joining the platform team. ",
  };

  it("invites the address under the role picked, in the organization the URL names", async () => {
    invoke.mockResolvedValue(invitation);
    expect(await sendInvitation("acme", draft)).toEqual({
      ok: true,
      value: {
        id: invitation.id,
        status: "pending",
        expiresAt: invitation.expires_at,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "send_workspace_invite",
      {
        email: "dana.reyes@acme.example",
        role: "admin",
        message: "Joining the platform team.",
      },
      // The org-only workspace sentinel: the contract is scoped, and the
      // workspace it enters is invocation scope the invitation never records.
      expect.objectContaining(TENANT),
    );
  });

  it("sends no note when the field was left blank", async () => {
    invoke.mockResolvedValue(invitation);
    await sendInvitation("acme", { ...draft, message: "   " });
    expect(invoke).toHaveBeenCalledWith(
      "send_workspace_invite",
      { email: "dana.reyes@acme.example", role: "admin" },
      expect.objectContaining(TENANT),
    );
  });

  it("reports the invitation that was already pending as ok, not as a failure", async () => {
    // The handler's insert conflicts, it re-reads the pending row and answers
    // with it, so a second invitation for the same email answers ok with the
    // id that row already had.
    invoke.mockResolvedValue(invitation);
    expect(await sendInvitation("acme", draft)).toMatchObject({
      ok: true,
      value: { id: invitation.id },
    });
  });

  it("refuses a role no invitation offers before the kernel runs (negative)", async () => {
    expect(
      await sendInvitation("acme", { ...draft, role: "compliance" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "role_not_invitable",
      field: "role",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an address the contract's schema does not accept before the kernel runs (negative)", async () => {
    expect(
      await sendInvitation("acme", { ...draft, email: "dana.reyes" }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "email" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a viewer the capability denies as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("send_workspace_invite"));
    expect(await sendInvitation("acme", draft)).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("a person the organization refuses", () => {
  it.each([
    ["changeMemberRole", () => changeMemberRole("acme", MEMBER, "admin")],
    ["removeOrgMember", () => removeOrgMember("acme", MEMBER)],
    [
      "sendInvitation",
      () =>
        sendInvitation("acme", {
          email: "dana.reyes@acme.example",
          role: "member",
          message: "",
        }),
    ],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe.each([
  ["resend_member_invite", resendInvitation, "pending"],
  ["revoke_member_invite", revokeInvitation, "revoked"],
] as const)("%s invitation action", (name, action, status) => {
  const invitationPublicId = "invi_4n5p6q7r8s9t0v1w2x3y4z";
  it("uses the organization viewer and validates the kernel result", async () => {
    const value = {
      invitationPublicId,
      status,
      expiresAt: null,
      ...(name === "resend_member_invite"
        ? { delivery: "accepted" as const }
        : {}),
    };
    invoke.mockResolvedValue(value);
    expect(await action("acme", invitationPublicId)).toEqual({
      ok: true,
      value,
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      name,
      { invitationPublicId },
      expect.objectContaining(TENANT),
    );
  });
  it("refuses malformed identity before invoking", async () => {
    expect(await action("acme", "other")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves handler refusal for a retryable row", async () => {
    invoke.mockRejectedValue(refusal("conflict", "invitation_not_pending"));
    expect(await action("acme", invitationPublicId)).toMatchObject({
      ok: false,
      reason: "conflict",
      code: "invitation_not_pending",
    });
  });
  it("runs nothing when the organization viewer is refused", async () => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(action("acme", invitationPublicId)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
