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
} from "./notifications.list";

describe("notifications.list handler", () => {
  it("exports schema and metadata", () => {
    expect(notificationsListSchema).toBeDefined();
    expect(notificationsListMetadata.name).toBe("notifications.list");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { notifications: [], unreadCount: 0 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { unreadOnly: false, limit: 50 };
    const result = await handler_notificationsList(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "notifications.list",
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
} from "./notifications.mark";

describe("notifications.mark handler", () => {
  it("exports schema and metadata", () => {
    expect(notificationsMarkSchema).toBeDefined();
    expect(notificationsMarkMetadata.name).toBe("notifications.mark");
  });

  it("calls invoke with mark args", async () => {
    const fakeOutput = { ok: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { id: "ntf_1", read: true as boolean | undefined, archived: undefined };
    await handler_notificationsMark(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "notifications.mark",
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
    expect(orgMemberAddMetadata.name).toBe("org.member.add");
  });

  it("calls invoke with add member args", async () => {
    const fakeOutput = { invitationId: "inv_1", email: "user@example.com", role: "Member", status: "pending", expiresAt: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { email: "user@example.com", role: "Member" };
    await handler_orgMemberAdd(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "org.member.add",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── org.member.invite.accept ──────────────────────────────────────────────────

import handler_orgMemberInviteAccept, {
  schema as orgMemberInviteAcceptSchema,
  metadata as orgMemberInviteAcceptMetadata,
} from "./org.member.invite.accept";

describe("org.member.invite.accept handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberInviteAcceptSchema).toBeDefined();
    expect(orgMemberInviteAcceptMetadata.name).toBe("org.member.invite.accept");
  });

  it("calls invoke with invite accept args", async () => {
    const fakeOutput = { orgUserId: "oru_1", orgId: "org_test", role: "Member", joinedAt: "2026-01-01T00:00:00.000Z" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { invitationPublicId: "inv_1" };
    await handler_orgMemberInviteAccept(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "org.member.invite.accept",
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
} from "./org.member.invite.decline";

describe("org.member.invite.decline handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberInviteDeclineSchema).toBeDefined();
    expect(orgMemberInviteDeclineMetadata.name).toBe("org.member.invite.decline");
  });

  it("calls invoke with invite decline args", async () => {
    const fakeOutput = { invitationPublicId: "inv_1", status: "declined" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { invitationPublicId: "inv_1" };
    await handler_orgMemberInviteDecline(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "org.member.invite.decline",
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
    expect(orgMemberRemoveMetadata.name).toBe("org.member.remove");
  });

  it("calls invoke with remove member args", async () => {
    const fakeOutput = { removed: true, targetUserId: "user_1", orgId: "org_test" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { targetUserId: "user_1" };
    await handler_orgMemberRemove(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "org.member.remove",
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
} from "./org.member.role.change";

describe("org.member.role.change handler", () => {
  it("exports schema and metadata", () => {
    expect(orgMemberRoleChangeSchema).toBeDefined();
    expect(orgMemberRoleChangeMetadata.name).toBe("org.member.role.change");
  });

  it("calls invoke with role change args", async () => {
    const fakeOutput = { changed: true, targetUserId: "user_1", orgId: "org_test", previousRole: "Member", newRole: "Admin" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { targetUserId: "user_1", newRole: "Admin" };
    await handler_orgMemberRoleChange(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "org.member.role.change",
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
} from "./organization.create";

describe("organization.create handler", () => {
  it("exports schema and metadata", () => {
    expect(organizationCreateSchema).toBeDefined();
    expect(organizationCreateMetadata.name).toBe("organization.create");
  });

  it("calls invoke with create args", async () => {
    const fakeOutput = { publicId: "org_new", name: "Acme Corp", slug: "acme-corp", type: "business", createdAt: "2026-01-01T00:00:00.000Z" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      name: "Acme Corp",
      slug: "acme-corp",
      planSlug: "free",
      type: "business" as const,
      website: undefined,
      industry: undefined,
      employeeSize: undefined,
      billingEmail: undefined,
      billingAddress: undefined,
    };
    await handler_organizationCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "organization.create",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(workspaceCreateMetadata.name).toBe("workspace.create");
  });

  it("calls invoke with workspace create args", async () => {
    const fakeOutput = { publicId: "ws_new", name: "My Workspace", slug: "my-workspace", orgSlug: "acme-corp", createdAt: "2026-01-01T00:00:00.000Z" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { name: "My Workspace", slug: "my-workspace" };
    await handler_workspaceCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "workspace.create",
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
    expect(userPreferencesReadMetadata.name).toBe("user.preferences.read");
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
      agentPanelButtonLocation: "lower-right",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_userPreferencesRead({});

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "user.preferences.read",
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
    expect(userPreferencesWriteMetadata.name).toBe("user.preferences.write");
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
      agentPanelButtonLocation: "lower-right" as const,
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
      agentPanelButtonLocation: undefined,
    };
    await handler_userPreferencesWrite(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "user.preferences.write",
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
} from "./workspace.model.settings.read";

describe("workspace.model.settings.read handler", () => {
  it("exports schema and metadata", () => {
    expect(workspaceModelSettingsReadSchema).toBeDefined();
    expect(workspaceModelSettingsReadMetadata.name).toBe("workspace.model.settings.read");
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
      "workspace.model.settings.read",
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
} from "./workspace.model.settings.write";

describe("workspace.model.settings.write handler", () => {
  it("exports schema and metadata", () => {
    expect(workspaceModelSettingsWriteSchema).toBeDefined();
    expect(workspaceModelSettingsWriteMetadata.name).toBe("workspace.model.settings.write");
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
      "workspace.model.settings.write",
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
    expect(systemInstallInstructionsMetadata.name).toBe("system.install.instructions");
  });

  it("calls invoke with install instructions args", async () => {
    const fakeOutput = {
      client: "claude-code" as const,
      steps: [{ label: "Run the install command" }],
      render: { componentId: "install-instructions", props: { client: "claude-code" } },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { client: "claude-code" as const, workspaceSlug: "my-workspace" };
    await handler_systemInstallInstructions(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "system.install.instructions",
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
    expect(workflowRunMetadata.name).toBe("workflow.run");
  });

  it("calls invoke with workflow run args", async () => {
    const fakeOutput = {
      workflowId: "uuid-wfr-1",
      publicId: "wfr_1",
      status: "planning" as const,
      render: { componentId: "workflow-progress" as const, props: { workflowId: "uuid-wfr-1" } },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { goal: "Profile Fortune 500 CEOs", title: undefined, outputFormat: "json" as const, maxParallelism: 10 };
    await handler_workflowRun(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "workflow.run",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(workflowStatusMetadata.name).toBe("workflow.status");
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
      "workflow.status",
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
    expect(workflowCancelMetadata.name).toBe("workflow.cancel");
  });

  it("calls invoke with workflow cancel args", async () => {
    const fakeOutput = { cancelled: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { workflowId: "wfr_1" };
    await handler_workflowCancel(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "workflow.cancel",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
