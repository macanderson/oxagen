// misc.handlers.test.ts — handler invocation tests for miscellaneous tools:
// notifications, org members, organization.create, workspace.create,
// user.preferences.*, workspace.model.settings.*, system.install.instructions,
// workflow.*, and organization tools.
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
    };
    await handler_organizationCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("create_org", args, fakeCtx, {
      surface: "mcp",
    });
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
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { name: "My Workspace", slug: "my-workspace" };
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
      defaultImageModel: null,
      defaultVideoModel: null,
      timezone: "UTC",
      language: "en",
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

// ── user.preferences.write ────────────────────────────────────────────────────

import handler_userPreferencesWrite, {
  schema as userPreferencesWriteSchema,
  metadata as userPreferencesWriteMetadata,
} from "./user.preferences.write";

describe("user.preferences.write handler", () => {
  it("exports schema and metadata", () => {
    expect(userPreferencesWriteSchema).toBeDefined();
    expect(userPreferencesWriteMetadata.name).toBe("update_user_preferences");
  });

  it("calls invoke with preference write args", async () => {
    const fakeOutput = {
      fontSize: "large" as const,
      density: "comfortable" as const,
      enterToSubmit: false,
      pendingPromptBehavior: "queue" as const,
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
      timezone: "America/New_York",
      language: "en",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      fontSize: "large" as const,
      density: undefined,
      enterToSubmit: false as boolean | undefined,
      pendingPromptBehavior: undefined,
      defaultTextTier: undefined,
      defaultTextModel: undefined,
      defaultImageModel: undefined,
      defaultVideoModel: undefined,
      timezone: undefined,
      language: undefined,
    };
    await handler_userPreferencesWrite(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_user_preferences",
      args,
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
      defaultImageModel: null,
      defaultVideoModel: null,
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
      defaultImageModel: null,
      defaultVideoModel: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      defaultTextTier: "balanced" as const,
      defaultTextModel: undefined,
      defaultImageModel: undefined,
      defaultVideoModel: undefined,
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

// ── workflow.run ──────────────────────────────────────────────────────────────

import handler_workflowRun, {
  schema as workflowRunSchema,
  metadata as workflowRunMetadata,
} from "./workflow.run";

describe("workflow.run handler", () => {
  it("exports schema and metadata", () => {
    expect(workflowRunSchema).toBeDefined();
    expect(workflowRunMetadata.name).toBe("run_workflow");
  });

  it("calls invoke with workflow run args", async () => {
    const fakeOutput = {
      workflowId: "uuid-wfr-1",
      publicId: "wfr_1",
      status: "planning" as const,
      render: {
        componentId: "workflow-progress" as const,
        props: { workflowId: "uuid-wfr-1" },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      goal: "Profile Fortune 500 CEOs",
      title: undefined,
      outputFormat: "json" as const,
      maxParallelism: 10,
    };
    await handler_workflowRun(args);

    expect(mocks.invoke).toHaveBeenCalledWith("run_workflow", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── workflow.status ───────────────────────────────────────────────────────────

import handler_workflowStatus, {
  schema as workflowStatusSchema,
  metadata as workflowStatusMetadata,
} from "./workflow.status";

describe("workflow.status handler", () => {
  it("exports schema and metadata", () => {
    expect(workflowStatusSchema).toBeDefined();
    expect(workflowStatusMetadata.name).toBe("get_workflow_status");
  });

  it("calls invoke with workflow status args", async () => {
    const fakeOutput = {
      workflow: {
        id: "uuid-wfr-1",
        publicId: "wfr_1",
        orgId: "org_test",
        workspaceId: "ws_test",
        title: "Fortune 500 Research",
        goal: "Profile Fortune 500 CEOs",
        status: "running" as const,
        planJson: null,
        totalTasks: 10,
        completedTasks: 3,
        failedTasks: 0,
        maxParallelism: 10,
        outputFormat: "json" as const,
        resultUrl: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      tasks: [],
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { workflowId: "wfr_1" };
    await handler_workflowStatus(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_workflow_status",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── workflow.cancel ───────────────────────────────────────────────────────────

import handler_workflowCancel, {
  schema as workflowCancelSchema,
  metadata as workflowCancelMetadata,
} from "./workflow.cancel";

describe("workflow.cancel handler", () => {
  it("exports schema and metadata", () => {
    expect(workflowCancelSchema).toBeDefined();
    expect(workflowCancelMetadata.name).toBe("cancel_workflow");
  });

  it("calls invoke with workflow cancel args", async () => {
    const fakeOutput = { cancelled: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { workflowId: "wfr_1" };
    await handler_workflowCancel(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "cancel_workflow",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
