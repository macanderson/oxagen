// misc.handlers.test.ts — handler invocation tests for miscellaneous tools:
// notifications, org members, organization.create, workspace.create,
// user.preferences.*, workspace.model.settings.*, system.install.instructions,
// and organization tools.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── notifications.list ────────────────────────────────────────────────────────

import handler_notificationsList, {
  schema as notificationsListSchema,
  metadata as notificationsListMetadata,
} from "./notification.list";

describe("notifications.list handler", () => {
  it("exports schema and metadata", () => {
    expect(notificationsListSchema).toBeDefined();
    expect(notificationsListMetadata.name).toBe("list_notifications");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { notifications: [], unreadCount: 0 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { unreadOnly: false, limit: 50 };
    const result = await handler_notificationsList(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_notifications",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ notifications: [], unreadCount: 0 });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("DB error"));
    await expect(
      handler_notificationsList({ unreadOnly: true, limit: 10 }),
    ).rejects.toThrow("DB error");
  });
});

// ── notifications.mark ────────────────────────────────────────────────────────

import handler_notificationsMark, {
  schema as notificationsMarkSchema,
  metadata as notificationsMarkMetadata,
} from "./notification.mark";

describe("notifications.mark handler", () => {
  it("exports schema and metadata", () => {
    expect(notificationsMarkSchema).toBeDefined();
    expect(notificationsMarkMetadata.name).toBe("mark_notification");
  });

  it("calls invoke with mark args", async () => {
    const fakeOutput = { ok: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      id: "ntf_1",
      read: true as boolean | undefined,
      archived: undefined,
    };
    await handler_notificationsMark(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "mark_notification",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── org.member.add ────────────────────────────────────────────────────────────

import handler_orgMemberAdd, {
  schema as orgMemberAddSchema,
  metadata as orgMemberAddMetadata,
} from "./org.member.add";

describe("org.member.add handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberAddSchema).toBeDefined();
    expect(orgMemberAddMetadata.name).toBe("add_org_member");
  });

  it("calls invoke with add member args", async () => {
    const fakeOutput = {
      invitationId: "inv_1",
      email: "user@example.com",
      role: "Member",
      status: "pending",
      expiresAt: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { email: "user@example.com", role: "Member" };
    await handler_orgMemberAdd(args);

    expect(mocks.invoke).toHaveBeenCalledWith("add_org_member", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── org.member.invite.accept ──────────────────────────────────────────────────

import handler_orgMemberInviteAccept, {
  schema as orgMemberInviteAcceptSchema,
  metadata as orgMemberInviteAcceptMetadata,
} from "./org.member_invite.accept";

describe("org.member.invite.accept handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberInviteAcceptSchema).toBeDefined();
    expect(orgMemberInviteAcceptMetadata.name).toBe("accept_member_invite");
  });

  it("calls invoke with invite accept args", async () => {
    const fakeOutput = {
      orgUserId: "oru_1",
      orgId: "org_test",
      role: "Member",
      joinedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { invitationPublicId: "inv_1" };
    await handler_orgMemberInviteAccept(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "accept_member_invite",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── org.member.invite.decline ─────────────────────────────────────────────────

import handler_orgMemberInviteDecline, {
  schema as orgMemberInviteDeclineSchema,
  metadata as orgMemberInviteDeclineMetadata,
} from "./org.member_invite.decline";

describe("org.member.invite.decline handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberInviteDeclineSchema).toBeDefined();
    expect(orgMemberInviteDeclineMetadata.name).toBe("decline_member_invite");
  });

  it("calls invoke with invite decline args", async () => {
    const fakeOutput = { invitationPublicId: "inv_1", status: "declined" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { invitationPublicId: "inv_1" };
    await handler_orgMemberInviteDecline(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "decline_member_invite",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── org.member.remove ─────────────────────────────────────────────────────────

import handler_orgMemberRemove, {
  schema as orgMemberRemoveSchema,
  metadata as orgMemberRemoveMetadata,
} from "./org.member.remove";

describe("org.member.remove handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberRemoveSchema).toBeDefined();
    expect(orgMemberRemoveMetadata.name).toBe("remove_org_member");
  });

  it("calls invoke with remove member args", async () => {
    const fakeOutput = {
      removed: true,
      targetUserId: "user_1",
      orgId: "org_test",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { targetUserId: "user_1" };
    await handler_orgMemberRemove(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "remove_org_member",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── org.member.role.change ────────────────────────────────────────────────────

import handler_orgMemberRoleChange, {
  schema as orgMemberRoleChangeSchema,
  metadata as orgMemberRoleChangeMetadata,
} from "./org.member_role.change";

describe("org.member.role.change handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberRoleChangeSchema).toBeDefined();
    expect(orgMemberRoleChangeMetadata.name).toBe("change_member_role");
  });

  it("calls invoke with role change args", async () => {
    const fakeOutput = {
      changed: true,
      targetUserId: "user_1",
      orgId: "org_test",
      previousRole: "Member",
      newRole: "Admin",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { targetUserId: "user_1", newRole: "Admin" };
    await handler_orgMemberRoleChange(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "change_member_role",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── organization.create ───────────────────────────────────────────────────────

import handler_organizationCreate, {
  schema as organizationCreateSchema,
  metadata as organizationCreateMetadata,
} from "./org.create";

describe("organization.create handler", () => {
  it("exports schema and metadata", () => {
    expect(organizationCreateSchema).toBeDefined();
    expect(organizationCreateMetadata.name).toBe("create_org");
  });

  it("calls invoke with create args", async () => {
    const fakeOutput = {
      publicId: "org_new",
      name: "Acme Corp",
      slug: "acme-corp",
      type: "business",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspace: { publicId: "ws_new", slug: "core" },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      name: "Acme Corp",
      slug: "acme-corp",
      planSlug: "free" as const,
      type: "business" as const,
      website: undefined,
      industry: undefined,
      employeeSize: undefined,
      workspace: { name: "Core", slug: "core" },
    };
    await handler_organizationCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("create_org", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── the role editor and archive_workspace (#2964) ────────────────────────────

import handler_iamRoleCreate, {
  metadata as iamRoleCreateMetadata,
} from "./iam.role.create";
import handler_iamRoleGrantsSet, {
  metadata as iamRoleGrantsSetMetadata,
} from "./iam.role.grants.set";
import handler_iamRoleDelete, {
  metadata as iamRoleDeleteMetadata,
} from "./iam.role.delete";
import handler_workspaceArchive, {
  metadata as workspaceArchiveMetadata,
} from "./workspace.archive";

describe("the role editor and archive_workspace tools", () => {
  const roleRow = {
    id: "rol_1",
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
    createdBy: "Dana Okafor",
  };

  it.each([
    [iamRoleCreateMetadata, "create_role"],
    [iamRoleGrantsSetMetadata, "set_role_grants"],
    [iamRoleDeleteMetadata, "delete_role"],
    [workspaceArchiveMetadata, "archive_workspace"],
  ])("registers %o under the contract name %s", (metadata, name) => {
    expect(metadata.name).toBe(name);
  });

  it("create_role invokes the kernel on the mcp surface and parses the row", async () => {
    mocks.invoke.mockResolvedValue({ role: roleRow });
    const args = {
      name: "agent.release",
      scopeKind: "workspace" as const,
      description: null,
      permissions: ["run.read"],
    };
    await expect(handler_iamRoleCreate(args)).resolves.toEqual({
      role: roleRow,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("create_role", args, fakeCtx, {
      surface: "mcp",
    });
  });

  it("set_role_grants and delete_role invoke the kernel on the mcp surface", async () => {
    mocks.invoke.mockResolvedValueOnce({ role: roleRow });
    await handler_iamRoleGrantsSet({
      roleId: "rol_1",
      permissions: ["run.read"],
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_role_grants",
      { roleId: "rol_1", permissions: ["run.read"] },
      fakeCtx,
      { surface: "mcp" },
    );
    mocks.invoke.mockResolvedValueOnce({ id: "rol_1", name: "agent.release" });
    await expect(handler_iamRoleDelete({ roleId: "rol_1" })).resolves.toEqual({
      id: "rol_1",
      name: "agent.release",
    });
  });

  it("archive_workspace invokes the kernel and refuses an output without archivedAt (negative)", async () => {
    mocks.invoke.mockResolvedValueOnce({
      id: "wrk_1",
      slug: "data",
      name: "Data",
      archivedAt: "2026-09-15T00:00:00.000Z",
      suspendedApiKeys: 0,
    });
    await expect(
      handler_workspaceArchive({ workspaceId: "wrk_1" }),
    ).resolves.toMatchObject({ id: "wrk_1", suspendedApiKeys: 0 });
    mocks.invoke.mockResolvedValueOnce({
      id: "wrk_1",
      slug: "data",
      name: "Data",
    });
    await expect(
      handler_workspaceArchive({ workspaceId: "wrk_1" }),
    ).rejects.toThrow();
  });
});

// ── workspace.create ──────────────────────────────────────────────────────────

import handler_workspaceCreate, {
  schema as workspaceCreateSchema,
  metadata as workspaceCreateMetadata,
} from "./workspace.create";

describe("workspace.create handler", () => {
  it("exports schema and metadata", () => {
    expect(workspaceCreateSchema).toBeDefined();
    expect(workspaceCreateMetadata.name).toBe("create_workspace");
  });

  it("calls invoke with workspace create args", async () => {
    const fakeOutput = {
      publicId: "ws_new",
      name: "My Workspace",
      slug: "my-workspace",
      orgSlug: "acme-corp",
      createdAt: "2026-01-01T00:00:00.000Z",
      mainRepo: {
        provider: "github",
        bindingId: "rpb_0a1b",
        connectionId: "con_0a1b",
        fullName: "acme/widgets",
        defaultRef: "main",
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      name: "My Workspace",
      slug: "my-workspace",
      mainRepo: { provider: "github" as const, owner: "acme", name: "widgets" },
    };
    await handler_workspaceCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_workspace",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── user.preferences.read ─────────────────────────────────────────────────────

import handler_userPreferencesRead, {
  schema as userPreferencesReadSchema,
  metadata as userPreferencesReadMetadata,
} from "./user.preferences.read";

describe("user.preferences.read handler", () => {
  it("exports schema and metadata", () => {
    expect(userPreferencesReadSchema).toBeDefined();
    expect(userPreferencesReadMetadata.name).toBe("get_user_preferences");
  });

  it("calls invoke with empty args for read", async () => {
    const fakeOutput = {
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      timezone: "UTC",
      language: "en",
      theme: "system",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_userPreferencesRead({});

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_user_preferences",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── workspace.model.settings.read ─────────────────────────────────────────────

import handler_workspaceModelSettingsRead, {
  schema as workspaceModelSettingsReadSchema,
  metadata as workspaceModelSettingsReadMetadata,
} from "./workspace.model_settings.read";

describe("workspace.model.settings.read handler", () => {
  it("exports schema and metadata", () => {
    expect(workspaceModelSettingsReadSchema).toBeDefined();
    expect(workspaceModelSettingsReadMetadata.name).toBe("get_model_settings");
  });

  it("calls invoke with empty args for read", async () => {
    const fakeOutput = {
      defaultTextTier: null,
      defaultTextModel: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_workspaceModelSettingsRead({});

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_model_settings",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── workspace.model.settings.write ────────────────────────────────────────────

import handler_workspaceModelSettingsWrite, {
  schema as workspaceModelSettingsWriteSchema,
  metadata as workspaceModelSettingsWriteMetadata,
} from "./workspace.model_settings.write";

describe("workspace.model.settings.write handler", () => {
  it("exports schema and metadata", () => {
    expect(workspaceModelSettingsWriteSchema).toBeDefined();
    expect(workspaceModelSettingsWriteMetadata.name).toBe(
      "update_model_settings",
    );
  });

  it("calls invoke with settings write args", async () => {
    const fakeOutput = {
      defaultTextTier: "balanced",
      defaultTextModel: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      defaultTextTier: "balanced" as const,
      defaultTextModel: undefined,
    };
    await handler_workspaceModelSettingsWrite(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_model_settings",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── system.install.instructions ───────────────────────────────────────────────

import handler_systemInstallInstructions, {
  schema as systemInstallInstructionsSchema,
  metadata as systemInstallInstructionsMetadata,
} from "./system.install.instructions";

describe("system.install.instructions handler", () => {
  it("exports schema and metadata", () => {
    expect(systemInstallInstructionsSchema).toBeDefined();
    expect(systemInstallInstructionsMetadata.name).toBe(
      "get_install_instructions",
    );
  });

  it("calls invoke with install instructions args", async () => {
    const fakeOutput = {
      client: "claude-code" as const,
      steps: [{ label: "Run the install command" }],
      render: {
        componentId: "install-instructions",
        props: { client: "claude-code" },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      client: "claude-code" as const,
      workspaceSlug: "my-workspace",
    };
    await handler_systemInstallInstructions(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_install_instructions",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
