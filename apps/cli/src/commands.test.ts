import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config and api-client before importing commands that use them
vi.mock("./lib/config.js", () => ({
  getToken: vi.fn(() => "test-token"),
  getApiUrl: vi.fn(() => "http://localhost:4000"),
  readConfig: vi.fn(() => ({ token: "test-token", orgSlug: "my-org", workspaceSlug: "default" })),
  writeConfig: vi.fn(),
  clearConfig: vi.fn(),
}));

vi.mock("./lib/api-client.js", () => ({
  apiRequest: vi.fn(),
  requireAuth: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

import { authLoginCommand } from "./commands/auth.login.js";
import { authLogoutCommand } from "./commands/auth.logout.js";
import { authWhoamiCommand } from "./commands/auth.whoami.js";
import { orgListCommand } from "./commands/org.list.js";
import { orgCreateCommand } from "./commands/org.create.js";
import { orgMemberAddCommand } from "./commands/org.member.add.js";
import { orgMemberRemoveCommand } from "./commands/org.member.remove.js";
import { workspaceListCommand } from "./commands/workspace.list.js";
import { workspaceCreateCommand } from "./commands/workspace.create.js";
import { chatSendCommand } from "./commands/chat.send.js";
import { conversationListCommand } from "./commands/conversation.list.js";
import { conversationDeleteCommand } from "./commands/conversation.delete.js";
import { conversationArchiveCommand } from "./commands/conversation.archive.js";
import { conversationRenameCommand } from "./commands/conversation.rename.js";
import { apiKeyCreateCommand } from "./commands/api-key.create.js";
import { apiKeyRevokeCommand } from "./commands/api-key.revoke.js";
import { notificationsListCommand } from "./commands/notifications.list.js";
import { notificationsMarkCommand } from "./commands/notifications.mark.js";
import { pluginListCommand } from "./commands/plugin.list.js";
import { pluginInstallCommand } from "./commands/plugin.install.js";
import { pluginUninstallCommand } from "./commands/plugin.uninstall.js";
import { pluginOrgInstallCommand } from "./commands/plugin.org.install.js";
import { pluginOrgUninstallCommand } from "./commands/plugin.org.uninstall.js";
import { pluginCatalogGetCommand } from "./commands/plugin.catalog.get.js";
import { billingStatusCommand } from "./commands/billing.status.js";
import { billingCreditsPurchaseCommand } from "./commands/billing.credits.purchase.js";
import { billingSubscriptionReadCommand } from "./commands/billing.subscription.read.js";
import { agentMcpListCommand } from "./commands/agent.mcp.list.js";
import { agentSkillListCommand } from "./commands/agent.skill.list.js";
import { agentToolListCommand } from "./commands/agent.tool.list.js";
import { orgMemberRoleChangeCommand } from "./commands/org.member.role.change.js";
import { agentApprovalResolveCommand } from "./commands/agent.approval.resolve.js";
import { archiveCreateCommand } from "./commands/archive.create.js";
import { workflowRunCommand } from "./commands/workflow.run.js";
import { userPreferencesGetCommand } from "./commands/user.preferences.get.js";
import { userPreferencesUpdateCommand } from "./commands/user.preferences.update.js";
import { workspaceMemberListCommand } from "./commands/workspace.member.list.js";
import { workspaceInviteSendCommand } from "./commands/workspace.invite.send.js";
import { conversationChatCommand } from "./commands/conversation.chat.js";
import { imageCreateCommand } from "./commands/image.create.js";
import { documentCreateCommand } from "./commands/document.create.js";
import { automationListCommand } from "./commands/automation.list.js";
import { imageListCommand } from "./commands/image.list.js";
import { imageAnalyzeCommand } from "./commands/image.analyze.js";
import { documentListCommand } from "./commands/document.list.js";
import { documentReadCommand } from "./commands/document.read.js";
import { formCreateCommand } from "./commands/form.create.js";
import { formSubmitCommand } from "./commands/form.submit.js";
import { automationCreateCommand } from "./commands/automation.create.js";
import { automationTriggerCommand } from "./commands/automation.trigger.js";
import { skillWorkspaceListCommand } from "./commands/skill.workspace.list.js";
import { agentMemoryRecallCommand } from "./commands/agent.memory.recall.js";
import { agentMemoryWriteCommand } from "./commands/agent.memory.write.js";
import { documentsGenerateCommand } from "./commands/documents.generate.js";
import { imageGenerateCommand } from "./commands/image.generate.js";
import { orgMemberInviteAcceptCommand } from "./commands/org.member.invite.accept.js";
import { pluginCatalogBrowseCommand } from "./commands/plugin.catalog.browse.js";
import { pluginCredentialReauthCommand } from "./commands/plugin.credential.reauth.js";
import { pluginRegistryAddCommand } from "./commands/plugin.registry.add.js";
import { pluginRegistryListCommand } from "./commands/plugin.registry.list.js";
import { svgGenerateCommand } from "./commands/svg.generate.js";
import { videoGenerateCommand } from "./commands/video.generate.js";
import { workspaceModelSettingsReadCommand } from "./commands/workspace.model.settings.read.js";
import { workspaceModelSettingsWriteCommand } from "./commands/workspace.model.settings.write.js";
import { agentMcpRegisterCommand } from "./commands/agent.mcp.register.js";
import { agentPlanApproveCommand } from "./commands/agent.plan.approve.js";
import { agentTaskBackgroundStartCommand } from "./commands/agent.task.background.start.js";
import { agentTaskBackgroundReadCommand } from "./commands/agent.task.background.read.js";
import { agentTaskBackgroundCancelCommand } from "./commands/agent.task.background.cancel.js";
import { assetUploadCommand } from "./commands/asset.upload.js";
import { billingSubscriptionUpgradeStartCommand } from "./commands/billing.subscription.upgrade.start.js";
import { brandkitApplyCommand } from "./commands/brandkit.apply.js";
import { conversationPurgeCommand } from "./commands/conversation.purge.js";
import { documentsPdfCreateCommand } from "./commands/documents.pdf.create.js";
import { formFillCommand } from "./commands/form.fill.js";
import { orgMemberInviteDeclineCommand } from "./commands/org.member.invite.decline.js";
import { organizationCreateCommand } from "./commands/organization.create.js";
import { pluginCredentialSetSecretCommand } from "./commands/plugin.credential.set_secret.js";
import { pluginDenylistAddCommand } from "./commands/plugin.denylist.add.js";
import { pluginDenylistRemoveCommand } from "./commands/plugin.denylist.remove.js";
import { pluginOrgInstallBulkCommand } from "./commands/plugin.org.install_bulk.js";
import { pluginOrgListCommand } from "./commands/plugin.org.list.js";
import { pluginOrgSetEnabledCommand } from "./commands/plugin.org.set_enabled.js";
import { pluginRegistryRemoveCommand } from "./commands/plugin.registry.remove.js";
import { pluginRegistrySyncCommand } from "./commands/plugin.registry.sync.js";
import { pluginSettingsSetAuthAlertsCommand } from "./commands/plugin.settings.set_auth_alerts.js";
import { pluginWorkspaceSetEnabledCommand } from "./commands/plugin.workspace.set_enabled.js";
import { systemInstallInstructionsCommand } from "./commands/system.install.instructions.js";
import { userPreferencesReadCommand } from "./commands/user.preferences.read.js";
import { userPreferencesWriteCommand } from "./commands/user.preferences.write.js";
import { workflowCancelCommand } from "./commands/workflow.cancel.js";
import { workflowStatusCommand } from "./commands/workflow.status.js";

import * as apiClient from "./lib/api-client.js";
import * as config from "./lib/config.js";

const mockApiRequest = vi.mocked(apiClient.apiRequest);
const mockRequireAuth = vi.mocked(apiClient.requireAuth);
const mockWriteConfig = vi.mocked(config.writeConfig);
const mockClearConfig = vi.mocked(config.clearConfig);
const mockGetToken = vi.mocked(config.getToken);

// Helper: throw an ApiError through apiRequest mock (covers instanceof branch in catch blocks)
function mockApiError(status: number, message: string) {
  const ApiErrorClass = apiClient.ApiError;
  mockApiRequest.mockRejectedValueOnce(new ApiErrorClass(status, message));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// auth login
// ---------------------------------------------------------------------------
describe("auth login", () => {
  it("exits 1 if email or password is missing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(() =>
      authLoginCommand.parseAsync(["node", "cli"])
    ).rejects.toThrow("exit");

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("email and password are required"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("calls API with credentials and stores token", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ token: "new-token", user: { email: "user@example.com" } });

    await authLoginCommand.parseAsync(["node", "cli", "--email", "user@example.com", "--password", "secret"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/auth/sign-in/email", expect.objectContaining({ method: "POST" }));
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Authenticated"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error during login", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Unauthorized"));

    await expect(() =>
      authLoginCommand.parseAsync(["node", "cli", "--email", "a@b.com", "--password", "pw"])
    ).rejects.toThrow("exit");

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("handles response with session.token shape", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ session: { token: "session-tok" } });

    await authLoginCommand.parseAsync(["node", "cli", "-e", "a@b.com", "-p", "pw"]);

    expect(mockWriteConfig).toHaveBeenCalledWith(expect.objectContaining({ token: "session-tok" }));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// auth logout
// ---------------------------------------------------------------------------
describe("auth logout", () => {
  it("clears config and reports success", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetToken.mockReturnValue("old-token");
    mockApiRequest.mockResolvedValueOnce({});

    await authLogoutCommand.parseAsync(["node", "cli"]);

    expect(mockClearConfig).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Signing out"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Signed out"));
    consoleSpy.mockRestore();
  });

  it("clears config even if sign-out API fails", async () => {
    mockGetToken.mockReturnValue("tok");
    mockApiRequest.mockRejectedValueOnce(new Error("network error"));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await authLogoutCommand.parseAsync(["node", "cli"]);
    expect(mockClearConfig).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("skips sign-out API call when no token is stored", async () => {
    mockGetToken.mockReturnValue(undefined);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await authLogoutCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockClearConfig).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// auth whoami
// ---------------------------------------------------------------------------
describe("auth whoami", () => {
  it("displays user, org, and workspace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      user: { email: "mac@example.com" },
      org: { slug: "my-org" },
      workspace: { slug: "default" },
    });

    await authWhoamiCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("mac@example.com"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("my-org"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("default"));
    consoleSpy.mockRestore();
  });

  it("falls back to config values for org/workspace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ user: { email: "mac@example.com" } });
    vi.mocked(config.readConfig).mockReturnValue({ orgSlug: "cfg-org", workspaceSlug: "cfg-ws" });

    await authWhoamiCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cfg-org"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(() => authWhoamiCommand.parseAsync(["node", "cli"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org list
// ---------------------------------------------------------------------------
describe("org list", () => {
  it("prints organization list", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      organizations: [{ slug: "acme", name: "ACME Corp" }],
    });

    await orgListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Organizations"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("acme"));
    consoleSpy.mockRestore();
  });

  it("prints empty message when no orgs", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ organizations: [] });

    await orgListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No organizations"));
    consoleSpy.mockRestore();
  });

  it("handles data array shape from API", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ data: [{ id: "id1", slug: "org-1", name: "Org 1" }] });

    await orgListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("org-1"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org create
// ---------------------------------------------------------------------------
describe("org create", () => {
  it("creates org and prints slug", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ organization: { slug: "new-org", name: "New Org" } });

    await orgCreateCommand.parseAsync(["node", "cli", "New Org"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/organizations", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("new-org"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Conflict"));

    await expect(() => orgCreateCommand.parseAsync(["node", "cli", "Dup"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org member add / remove
// ---------------------------------------------------------------------------
describe("org member add", () => {
  it("adds member and confirms", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await orgMemberAddCommand.parseAsync(["node", "cli", "new@example.com", "--role", "admin"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/org/members", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("new@example.com"));
    consoleSpy.mockRestore();
  });

  it("defaults role to member when no --role flag given", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await orgMemberAddCommand.parseAsync(["node", "cli", "x@example.com", "--role", "member"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("member"));
    consoleSpy.mockRestore();
  });
});

describe("org member remove", () => {
  it("removes member and confirms", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await orgMemberRemoveCommand.parseAsync(["node", "cli", "old@example.com"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/org/members", expect.objectContaining({ method: "DELETE" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("old@example.com"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workspace list / create
// ---------------------------------------------------------------------------
describe("workspace list", () => {
  it("prints workspace list", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      workspaces: [{ slug: "default", name: "Default" }],
    });

    await workspaceListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspaces"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("default"));
    consoleSpy.mockRestore();
  });

  it("prints empty message when no workspaces", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ workspaces: [] });

    await workspaceListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No workspaces"));
    consoleSpy.mockRestore();
  });

  it("passes org query param when provided", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ workspaces: [] });

    await workspaceListCommand.parseAsync(["node", "cli", "--org", "my-org"]);

    expect(mockApiRequest).toHaveBeenCalledWith(expect.stringContaining("my-org"));
    consoleSpy.mockRestore();
  });
});

describe("workspace create", () => {
  it("creates workspace and prints slug", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ workspace: { slug: "my-ws", name: "My WS" } });

    await workspaceCreateCommand.parseAsync(["node", "cli", "My WS"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/workspaces", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("my-ws"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// chat send
// ---------------------------------------------------------------------------
describe("chat send", () => {
  it("sends message and prints response", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ content: "Hello back!" });

    await chatSendCommand.parseAsync(["node", "cli", "hello"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("hello"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Hello back!"));
    consoleSpy.mockRestore();
  });

  it("passes conversation id when provided", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ content: "response" });

    await chatSendCommand.parseAsync(["node", "cli", "hi", "--conversation", "cnv_abc"]);

    const calls = mockApiRequest.mock.calls as unknown[][];
    const init = calls[0]?.[1] as Record<string, unknown> | undefined;
    const callBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(callBody.conversationId).toBe("cnv_abc");
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("timeout"));

    await expect(() => chatSendCommand.parseAsync(["node", "cli", "msg"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// conversation commands
// ---------------------------------------------------------------------------
describe("conversation list", () => {
  it("lists conversations", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      conversations: [{ publicId: "cnv_1", title: "First conversation" }],
    });

    await conversationListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Conversations"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cnv_1"));
    consoleSpy.mockRestore();
  });

  it("shows empty message when no conversations", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ conversations: [] });

    await conversationListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No conversations"));
    consoleSpy.mockRestore();
  });

  it("passes filter and limit params", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ conversations: [] });

    await conversationListCommand.parseAsync(["node", "cli", "--filter", "archived", "--limit", "5"]);

    expect(mockApiRequest).toHaveBeenCalledWith(expect.stringContaining("archived"));
    consoleSpy.mockRestore();
  });
});

describe("conversation delete", () => {
  it("deletes conversation and confirms", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await conversationDeleteCommand.parseAsync(["node", "cli", "cnv_abc"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/conversations/cnv_abc", expect.objectContaining({ method: "DELETE" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cnv_abc"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on not found", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Not found"));

    await expect(() => conversationDeleteCommand.parseAsync(["node", "cli", "bad"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("conversation archive", () => {
  it("archives conversation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await conversationArchiveCommand.parseAsync(["node", "cli", "cnv_abc"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/conversations/cnv_abc/archive", expect.anything());
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("archived"));
    consoleSpy.mockRestore();
  });

  it("unarchives when --unarchive flag is set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await conversationArchiveCommand.parseAsync(["node", "cli", "cnv_abc", "--unarchive"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("unarchived"));
    consoleSpy.mockRestore();
  });
});

describe("conversation rename", () => {
  it("renames conversation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await conversationRenameCommand.parseAsync(["node", "cli", "cnv_abc", "New Title"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/conversations/cnv_abc/rename", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("New Title"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// api-key
// ---------------------------------------------------------------------------
describe("api-key create", () => {
  it("creates API key and displays secret", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "key_123", key: "oxk_abc123secret" });
    const origIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true; // Simulate interactive TTY to show full secret

    await apiKeyCreateCommand.parseAsync(["node", "cli", "my-key"]);

    process.stdout.isTTY = origIsTTY; // Restore
    expect(mockApiRequest).toHaveBeenCalledWith("/api-keys", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("key_123"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("oxk_abc123secret"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Quota exceeded"));

    await expect(() => apiKeyCreateCommand.parseAsync(["node", "cli", "key"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("api-key revoke", () => {
  it("revokes API key", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await apiKeyRevokeCommand.parseAsync(["node", "cli", "key_123"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/api-keys/key_123", expect.objectContaining({ method: "DELETE" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("key_123"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------
describe("notifications list", () => {
  it("lists notifications with unread marker", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      notifications: [
        { publicId: "ntf_1", title: "New member joined", readAt: null },
        { publicId: "ntf_2", title: "Subscription renewed", readAt: "2026-06-01" },
      ],
    });

    await notificationsListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ntf_1"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ntf_2"));
    consoleSpy.mockRestore();
  });

  it("shows empty message when none", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ notifications: [] });

    await notificationsListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No notifications"));
    consoleSpy.mockRestore();
  });

  it("passes unread filter", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ notifications: [] });

    await notificationsListCommand.parseAsync(["node", "cli", "--unread"]);

    expect(mockApiRequest).toHaveBeenCalledWith(expect.stringContaining("unread"));
    consoleSpy.mockRestore();
  });
});

describe("notifications mark", () => {
  it("marks notification as read", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await notificationsMarkCommand.parseAsync(["node", "cli", "ntf_1"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/notifications/ntf_1/mark", expect.anything());
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("read"));
    consoleSpy.mockRestore();
  });

  it("marks notification as unread with --unread flag", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await notificationsMarkCommand.parseAsync(["node", "cli", "ntf_1", "--unread"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("unread"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------
describe("plugin list", () => {
  it("lists installed plugins", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      plugins: [{ pluginId: "github", enabled: true }, { pluginId: "slack", enabled: false }],
    });

    await pluginListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("github"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("enabled"));
    consoleSpy.mockRestore();
  });

  it("shows empty message when no plugins", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ plugins: [] });

    await pluginListCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No plugins"));
    consoleSpy.mockRestore();
  });
});

describe("plugin install", () => {
  it("installs plugin", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await pluginInstallCommand.parseAsync(["node", "cli", "github"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/plugins/install", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("github"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on install failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Not found in catalog"));

    await expect(() => pluginInstallCommand.parseAsync(["node", "cli", "bad-plugin"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("plugin uninstall", () => {
  it("uninstalls plugin", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await pluginUninstallCommand.parseAsync(["node", "cli", "slack"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/plugins/uninstall", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("slack"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// billing status
// ---------------------------------------------------------------------------
describe("billing status", () => {
  it("shows subscription plan and status", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      subscription: {
        plan: { name: "Scale" },
        status: "active",
        currentPeriodEnd: "2026-07-01",
      },
      creditBalance: { balanceUsd: 42.5 },
    });

    await billingStatusCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Scale"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("active"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("42.50"));
    consoleSpy.mockRestore();
  });

  it("shows 'No active subscription' when absent", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({});

    await billingStatusCommand.parseAsync(["node", "cli"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No active subscription"));
    consoleSpy.mockRestore();
  });

  it("exits 1 on API error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(() => billingStatusCommand.parseAsync(["node", "cli"])).rejects.toThrow("exit");
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent mcp list
// ---------------------------------------------------------------------------
describe("agent mcp list", () => {
  it("lists MCP servers successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      servers: [{ id: "mcp1", name: "claude", status: "active" }],
    });

    await agentMcpListCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/agent/mcp/list?", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("MCP Servers"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent skill list
// ---------------------------------------------------------------------------
describe("agent skill list", () => {
  it("lists agent skills successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      skills: [{ id: "skill1", name: "memory", description: "Memory management" }],
    });

    await agentSkillListCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/agent/skill/list?", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Agent Skills"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent tool list
// ---------------------------------------------------------------------------
describe("agent tool list", () => {
  it("lists agent tools successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      tools: [{ id: "tool1", name: "search", description: "Search capability" }],
    });

    await agentToolListCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/agent/tool/list?", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Agent Tools"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// billing credits purchase
// ---------------------------------------------------------------------------
describe("billing credits purchase", () => {
  it("purchases credits successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      credits: 100,
      totalCost: 10,
    });

    await billingCreditsPurchaseCommand.parseAsync(["node", "cli", "-a", "100"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/billing/credits/purchase", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Purchase initiated"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// billing subscription read
// ---------------------------------------------------------------------------
describe("billing subscription read", () => {
  it("reads subscription details successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      subscription: { id: "sub1", plan: "scale", status: "active" },
    });

    await billingSubscriptionReadCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/billing/subscription/read?", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Current Subscription"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin org install
// ---------------------------------------------------------------------------
describe("plugin org install", () => {
  it("installs plugin for organization", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      id: "plugin1",
      name: "github",
      status: "installed",
    });

    await pluginOrgInstallCommand.parseAsync(["node", "cli", "-n", "github"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/org/install", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Plugin installed"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin org uninstall
// ---------------------------------------------------------------------------
describe("plugin org uninstall", () => {
  it("uninstalls plugin from organization", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      id: "plugin1",
      status: "uninstalled",
    });

    await pluginOrgUninstallCommand.parseAsync(["node", "cli", "-p", "plugin1"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/org/uninstall", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Plugin uninstalled"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin catalog get
// ---------------------------------------------------------------------------
describe("plugin catalog get", () => {
  it("browses plugin catalog", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      plugins: [{ id: "p1", name: "github", description: "GitHub integration", category: "vcs" }],
    });

    await pluginCatalogGetCommand.parseAsync(["node", "cli"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/catalog/get?", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Available Plugins"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org member role change
// ---------------------------------------------------------------------------
describe("org member role change", () => {
  it("changes member role successfully", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      userId: "user1",
      role: "admin",
      updated: true,
    });

    await orgMemberRoleChangeCommand.parseAsync(["node", "cli", "-u", "user1", "-r", "admin"]);

    expect(mockApiRequest).toHaveBeenCalledWith("/org/member/role-change", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Role updated"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent approval resolve
// ---------------------------------------------------------------------------
describe("agent approval resolve", () => {
  it("resolves approval with approve decision", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "apr1", status: "approved" });
    await agentApprovalResolveCommand.parseAsync(["node", "cli", "-a", "apr1", "-d", "approve"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/approval/resolve", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("approved"));
    consoleSpy.mockRestore();
  });
  it("rejects invalid decision", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(() =>
      agentApprovalResolveCommand.parseAsync(["node", "cli", "-a", "apr1", "-d", "invalid"])
    ).rejects.toThrow();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// archive create
// ---------------------------------------------------------------------------
describe("archive create", () => {
  it("creates archive from conversation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "arc1", name: "Archive 1", status: "created" });
    await archiveCreateCommand.parseAsync(["node", "cli", "-c", "conv1", "-n", "My Archive"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/archive/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Archive created"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workflow run
// ---------------------------------------------------------------------------
describe("workflow run", () => {
  it("runs workflow with input", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "run1", status: "started" });
    await workflowRunCommand.parseAsync(["node", "cli", "-w", "wf1", "--input", '{"key":"value"}']);
    expect(mockApiRequest).toHaveBeenCalledWith("/workflow/run", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("started"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// user preferences
// ---------------------------------------------------------------------------
describe("user preferences get", () => {
  it("fetches user preferences", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ theme: "dark", language: "en" });
    await userPreferencesGetCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/user/preferences/get", expect.any(Object));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("dark"));
    consoleSpy.mockRestore();
  });
});

describe("user preferences update", () => {
  it("updates user preferences", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ theme: "light" });
    await userPreferencesUpdateCommand.parseAsync(["node", "cli", "-t", "light"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/user/preferences/update", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("light"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workspace management
// ---------------------------------------------------------------------------
describe("workspace member list", () => {
  it("lists workspace members", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce([{ id: "m1", email: "user@example.com", role: "member", joined_at: "2026-06-08" }]);
    await workspaceMemberListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("member(s)"));
    consoleSpy.mockRestore();
  });
});

describe("workspace invite send", () => {
  it("sends workspace invitation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "inv1", status: "sent" });
    await workspaceInviteSendCommand.parseAsync(["node", "cli", "-e", "user@example.com"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/workspace/invite/send", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Invitation sent"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// conversation chat
// ---------------------------------------------------------------------------
describe("conversation chat", () => {
  it("sends chat message", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "msg1", created_at: "2026-06-08T00:00:00Z" });
    await conversationChatCommand.parseAsync(["node", "cli", "-c", "conv1", "-m", "Hello"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/conversation/chat", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Message sent"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// image management
// ---------------------------------------------------------------------------
describe("image create", () => {
  it("creates image from prompt", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "img1", url: "https://example.com/img1.jpg" });
    await imageCreateCommand.parseAsync(["node", "cli", "-p", "A blue sky"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/image/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Image created"));
    consoleSpy.mockRestore();
  });
});

describe("image list", () => {
  it("lists images", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ images: [{ id: "img1", url: "https://example.com/img1.jpg", prompt: "Blue sky", created_at: "2026-06-08" }] });
    await imageListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Images"));
    consoleSpy.mockRestore();
  });
});

describe("image analyze", () => {
  it("analyzes image", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ analysis: "sky", tags: ["nature", "outdoor"] });
    await imageAnalyzeCommand.parseAsync(["node", "cli", "-i", "img1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/image/analyze", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Analysis"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// document management
// ---------------------------------------------------------------------------
describe("document create", () => {
  it("creates document", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "doc1", title: "My Doc" });
    await documentCreateCommand.parseAsync(["node", "cli", "-t", "My Doc"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/document/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Document created"));
    consoleSpy.mockRestore();
  });
});

describe("document list", () => {
  it("lists documents", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ documents: [{ id: "doc1", title: "Doc 1", created_at: "2026-06-08", updated_at: "2026-06-08", author: "user" }] });
    await documentListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Documents"));
    consoleSpy.mockRestore();
  });
});

describe("document read", () => {
  it("reads document", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ title: "Doc 1", content: "Content...", metadata: {}, created_at: "2026-06-08" });
    await documentReadCommand.parseAsync(["node", "cli", "-d", "doc1"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Title:"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// form management
// ---------------------------------------------------------------------------
describe("form create", () => {
  it("creates form", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "form1", title: "Survey" });
    await formCreateCommand.parseAsync(["node", "cli", "-t", "Survey"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/form/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Form created"));
    consoleSpy.mockRestore();
  });
});

describe("form submit", () => {
  it("submits form", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "sub1", status: "submitted" });
    await formSubmitCommand.parseAsync(["node", "cli", "-f", "form1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/form/submit", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("submitted"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// automation management
// ---------------------------------------------------------------------------
describe("automation list", () => {
  it("lists automations", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce([{ id: "auto1", name: "Auto 1", status: "active", triggers: ["event1"] }]);
    await automationListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("automation(s)"));
    consoleSpy.mockRestore();
  });
});

describe("automation create", () => {
  it("creates automation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "auto1", name: "My Automation" });
    await automationCreateCommand.parseAsync(["node", "cli", "-n", "My Automation"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/automation/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Automation created"));
    consoleSpy.mockRestore();
  });
});

describe("automation trigger", () => {
  it("triggers automation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "exec1", status: "running" });
    await automationTriggerCommand.parseAsync(["node", "cli", "-a", "auto1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/automation/trigger", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("running"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// skill management
// ---------------------------------------------------------------------------
describe("skill workspace list", () => {
  it("lists workspace skills", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ skills: [{ id: "skill1", name: "Research", enabled: true, description: "Research skill" }] });
    await skillWorkspaceListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Workspace skills"));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent memory commands
// ---------------------------------------------------------------------------
describe("agent memory recall", () => {
  it("recalls memory observations", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockResult = { observations: [{ id: "obs1", text: "User prefers dark mode", score: 0.9 }] };
    mockApiRequest.mockResolvedValueOnce(mockResult);
    await agentMemoryRecallCommand.parseAsync(["node", "cli", "-a", "agent1", "-q", "user preferences"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/memory/recall", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("obs1"));
    consoleSpy.mockRestore();
  });

  it("handles recall failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Network error"));
    await expect(agentMemoryRecallCommand.parseAsync(["node", "cli", "-a", "agent1", "-q", "query"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to recall"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("agent memory write", () => {
  it("writes a memory observation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockResult = { id: "obs2", status: "stored" };
    mockApiRequest.mockResolvedValueOnce(mockResult);
    await agentMemoryWriteCommand.parseAsync(["node", "cli", "-a", "agent1", "-t", "User prefers TypeScript"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/memory/write", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("obs2"));
    consoleSpy.mockRestore();
  });

  it("writes a memory observation with tags", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "obs3", status: "stored" });
    await agentMemoryWriteCommand.parseAsync(["node", "cli", "-a", "agent1", "-t", "Uses dark mode", "--tags", "ui,preferences"]);
    const callBody = JSON.parse((mockApiRequest.mock.calls[0]![1] as { body: string }).body);
    expect(callBody.tags).toEqual(["ui", "preferences"]);
    consoleSpy.mockRestore();
  });

  it("handles write failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Network error"));
    await expect(agentMemoryWriteCommand.parseAsync(["node", "cli", "-a", "agent1", "-t", "text"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to write"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// documents generate
// ---------------------------------------------------------------------------
describe("documents generate", () => {
  it("generates a document from template", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockResult = { id: "doc1", status: "complete", url: "https://example.com/doc.pdf" };
    mockApiRequest.mockResolvedValueOnce(mockResult);
    await documentsGenerateCommand.parseAsync(["node", "cli", "-t", "report", "-c", '{"title":"Q1 Report"}']);
    expect(mockApiRequest).toHaveBeenCalledWith("/documents/generate", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("doc1"));
    consoleSpy.mockRestore();
  });

  it("fails on invalid JSON context", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    await expect(documentsGenerateCommand.parseAsync(["node", "cli", "-t", "report", "-c", "not-json"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), expect.anything());
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("handles generate failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Template not found"));
    await expect(documentsGenerateCommand.parseAsync(["node", "cli", "-t", "report", "-c", '{}'])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to generate"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// image generate
// ---------------------------------------------------------------------------
describe("image generate", () => {
  it("generates an image and logs JSON result", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockResult = { url: "https://example.com/img.png", id: "img1" };
    mockApiRequest.mockResolvedValueOnce(mockResult);
    await imageGenerateCommand.parseAsync(["node", "cli", "-p", "A sunset over the ocean"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/image/generate", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("img1"));
    consoleSpy.mockRestore();
  });

  it("handles generate failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Model not found"));
    await expect(imageGenerateCommand.parseAsync(["node", "cli", "-p", "a cat"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to generate"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org member invite accept
// ---------------------------------------------------------------------------
describe("org member invite accept", () => {
  it("accepts an invitation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ status: "accepted", orgSlug: "my-org" });
    await orgMemberInviteAcceptCommand.parseAsync(["node", "cli", "-i", "invite123"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/org/member/invite/accept", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("accepted"));
    consoleSpy.mockRestore();
  });

  it("handles accept failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Invitation expired"));
    await expect(orgMemberInviteAcceptCommand.parseAsync(["node", "cli", "-i", "inv1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to accept"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin catalog browse
// ---------------------------------------------------------------------------
describe("plugin catalog browse", () => {
  it("browses the plugin catalog", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockResult = { plugins: [{ id: "p1", name: "Slack", category: "messaging" }], total: 1 };
    mockApiRequest.mockResolvedValueOnce(mockResult);
    await pluginCatalogBrowseCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/catalog/browse", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Slack"));
    consoleSpy.mockRestore();
  });

  it("handles browse failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Service unavailable"));
    await expect(pluginCatalogBrowseCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to browse"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin credential reauth
// ---------------------------------------------------------------------------
describe("plugin credential reauth", () => {
  it("re-authenticates plugin credentials", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ status: "reauthenticated", pluginId: "slack" });
    await pluginCredentialReauthCommand.parseAsync(["node", "cli", "-p", "slack"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/credential/reauth", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reauthenticated"));
    consoleSpy.mockRestore();
  });

  it("handles reauth failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("OAuth error"));
    await expect(pluginCredentialReauthCommand.parseAsync(["node", "cli", "-p", "slack"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to re-authenticate"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin registry
// ---------------------------------------------------------------------------
describe("plugin registry list", () => {
  it("lists plugin registries", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ registries: [{ id: "reg1", name: "Official", url: "https://registry.oxagen.ai" }] });
    await pluginRegistryListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/registry/list", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Official"));
    consoleSpy.mockRestore();
  });

  it("handles list failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Network error"));
    await expect(pluginRegistryListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to list"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("plugin registry add", () => {
  it("adds a plugin registry", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "reg2", name: "Private", url: "https://private.example.com" });
    await pluginRegistryAddCommand.parseAsync(["node", "cli", "-n", "Private", "-u", "https://private.example.com"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/registry/add", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reg2"));
    consoleSpy.mockRestore();
  });

  it("handles add failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Registry already exists"));
    await expect(pluginRegistryAddCommand.parseAsync(["node", "cli", "-n", "Private", "-u", "https://x.com"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to add"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// svg generate
// ---------------------------------------------------------------------------
describe("svg generate", () => {
  it("generates SVG and logs it", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ svg: "<svg><rect/></svg>" });
    await svgGenerateCommand.parseAsync(["node", "cli", "-d", "A red circle"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/svg/generate", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("<svg>"));
    consoleSpy.mockRestore();
  });

  it("handles generate failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Generation failed"));
    await expect(svgGenerateCommand.parseAsync(["node", "cli", "-d", "circle"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to generate"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// video generate
// ---------------------------------------------------------------------------
describe("video generate", () => {
  it("generates a video", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "vid1", status: "processing", url: null });
    await videoGenerateCommand.parseAsync(["node", "cli", "-p", "A flying eagle"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/video/generate", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("vid1"));
    consoleSpy.mockRestore();
  });

  it("handles generate failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Model not available"));
    await expect(videoGenerateCommand.parseAsync(["node", "cli", "-p", "a cat"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to generate"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workspace model settings
// ---------------------------------------------------------------------------
describe("workspace model settings read", () => {
  it("reads workspace model settings", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ defaultModel: "claude-haiku-4-5-20251001", maxTokens: 4096 });
    await workspaceModelSettingsReadCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/workspace/model-settings/read", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("defaultModel"));
    consoleSpy.mockRestore();
  });

  it("handles read failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Workspace not found"));
    await expect(workspaceModelSettingsReadCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to read"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("workspace model settings write", () => {
  it("writes workspace model settings", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ success: true, key: "defaultModel", value: "claude-sonnet-4-6" });
    await workspaceModelSettingsWriteCommand.parseAsync(["node", "cli", "-k", "defaultModel", "-v", "claude-sonnet-4-6"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/workspace/model-settings/write", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("defaultModel"));
    consoleSpy.mockRestore();
  });

  it("handles write failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Invalid setting key"));
    await expect(workspaceModelSettingsWriteCommand.parseAsync(["node", "cli", "-k", "badKey", "-v", "value"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to write"), expect.any(Error));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent mcp register
// ---------------------------------------------------------------------------
describe("agent mcp register", () => {
  it("registers an MCP server", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ mcpServerId: "mcp1", healthStatus: "healthy", discoveredTools: ["tool1", "tool2"] });
    await agentMcpRegisterCommand.parseAsync(["node", "cli", "-n", "My MCP", "-u", "https://mcp.example.com", "-t", "streamable-http"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/mcp/register", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("mcp1"));
    consoleSpy.mockRestore();
  });

  it("handles registration failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Bad URL"));
    await expect(agentMcpRegisterCommand.parseAsync(["node", "cli", "-n", "M", "-u", "http://x", "-t", "stdio"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent plan approve
// ---------------------------------------------------------------------------
describe("agent plan approve", () => {
  it("approves a plan", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ planId: "plan1", status: "approved" });
    await agentPlanApproveCommand.parseAsync(["node", "cli", "-p", "plan1", "-d", "approve"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/plan/approve", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("approved"));
    consoleSpy.mockRestore();
  });

  it("handles approval failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Plan not found"));
    await expect(agentPlanApproveCommand.parseAsync(["node", "cli", "-p", "p1", "-d", "deny"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// agent task background
// ---------------------------------------------------------------------------
describe("agent task background start", () => {
  it("starts a background task", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ taskId: "task1", inngestRunId: "run1" });
    await agentTaskBackgroundStartCommand.parseAsync(["node", "cli", "-k", "research", "--payload", '{"query":"test"}']);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/task/background/start", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("task1"));
    consoleSpy.mockRestore();
  });

  it("handles start failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Queue full"));
    await expect(agentTaskBackgroundStartCommand.parseAsync(["node", "cli", "-k", "kind", "--payload", "{}"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("agent task background read", () => {
  it("reads task status", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ taskId: "task1", kind: "research", status: "completed", label: "My task", resultPayload: { answer: "42" }, failureReason: null, createdAt: "2026-06-08", startedAt: "2026-06-08", completedAt: "2026-06-08" });
    await agentTaskBackgroundReadCommand.parseAsync(["node", "cli", "-t", "task1"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("completed"));
    consoleSpy.mockRestore();
  });

  it("handles read failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Not found"));
    await expect(agentTaskBackgroundReadCommand.parseAsync(["node", "cli", "-t", "t1"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("agent task background cancel", () => {
  it("cancels a background task", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ cancelled: true });
    await agentTaskBackgroundCancelCommand.parseAsync(["node", "cli", "-t", "task1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/agent/task/background/cancel", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
    consoleSpy.mockRestore();
  });

  it("reports task could not be cancelled", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ cancelled: false });
    await agentTaskBackgroundCancelCommand.parseAsync(["node", "cli", "-t", "task1"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("could not be cancelled"));
    consoleSpy.mockRestore();
  });

  it("handles cancel failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Not found"));
    await expect(agentTaskBackgroundCancelCommand.parseAsync(["node", "cli", "-t", "t1"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// asset upload
// ---------------------------------------------------------------------------
describe("asset upload", () => {
  it("uploads an asset", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ url: "https://cdn.example.com/img.png", key: "img/abc.png", contentType: "image/png", bytes: 12345 });
    await assetUploadCommand.parseAsync(["node", "cli", "-s", "https://example.com/img.png", "-k", "image"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/asset/upload", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Asset uploaded"));
    consoleSpy.mockRestore();
  });

  it("handles upload failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Source URL unreachable"));
    await expect(assetUploadCommand.parseAsync(["node", "cli", "-s", "https://bad.url", "-k", "image"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// billing subscription upgrade start
// ---------------------------------------------------------------------------
describe("billing subscription upgrade start", () => {
  it("starts a checkout session", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ checkoutUrl: "https://checkout.stripe.com/pay/cs_test_123", planSlug: "scale", interval: "month" });
    await billingSubscriptionUpgradeStartCommand.parseAsync(["node", "cli", "-p", "scale", "-i", "month", "--success-url", "https://app.oxagen.ai/success", "--cancel-url", "https://app.oxagen.ai/cancel"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/billing/subscription/upgrade/start", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Checkout session created"));
    consoleSpy.mockRestore();
  });

  it("handles upgrade failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Stripe error"));
    await expect(billingSubscriptionUpgradeStartCommand.parseAsync(["node", "cli", "-p", "scale", "-i", "month", "--success-url", "https://a.com/ok", "--cancel-url", "https://a.com/cancel"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// brandkit apply
// ---------------------------------------------------------------------------
describe("brandkit apply", () => {
  it("applies a brand kit", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ stub: true, applied: false, brandKitId: "bk1", targetFileId: "file1" });
    await brandkitApplyCommand.parseAsync(["node", "cli", "-b", "bk1", "-f", "file1", "-w", "ws1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/brandkit/apply", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("stub"));
    consoleSpy.mockRestore();
  });

  it("handles apply failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Brand kit not found"));
    await expect(brandkitApplyCommand.parseAsync(["node", "cli", "-b", "bk1", "-f", "f1", "-w", "ws1"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// conversation purge
// ---------------------------------------------------------------------------
describe("conversation purge", () => {
  it("purges archived conversations with --yes", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ deleted: 5 });
    await conversationPurgeCommand.parseAsync(["node", "cli", "-w", "ws1", "--yes"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/conversation/purge", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Purged 5"));
    consoleSpy.mockRestore();
  });

  it("exits without --yes", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    await expect(conversationPurgeCommand.parseAsync(["node", "cli", "-w", "ws1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("handles purge failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Workspace not found"));
    await expect(conversationPurgeCommand.parseAsync(["node", "cli", "-w", "ws1", "--yes"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// documents pdf create
// ---------------------------------------------------------------------------
describe("documents pdf create", () => {
  it("creates a PDF document", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ assetId: "asset1", publicId: "pub1", kind: "pdf", mimeType: "application/pdf", sizeBytes: 50000, url: "https://blob.example.com/doc.pdf", serveUrl: "https://api.example.com/assets/asset1" });
    await documentsPdfCreateCommand.parseAsync(["node", "cli", "-t", "Q1 Report"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/documents/pdf/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("PDF created"));
    consoleSpy.mockRestore();
  });

  it("handles pdf create failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Generation failed"));
    await expect(documentsPdfCreateCommand.parseAsync(["node", "cli", "-t", "Report"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// form fill
// ---------------------------------------------------------------------------
describe("form fill", () => {
  it("fills form fields", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fields = [{ name: "firstName", label: "First Name", type: "text", current: "", changed: false, proposed: "Alice", reason: "Inferred from instruction" }];
    mockApiRequest.mockResolvedValueOnce({ fields });
    await formFillCommand.parseAsync(["node", "cli", "-r", "/profile", "-i", "Fill with Alice's info", "--fields", '[{"name":"firstName","label":"First Name","type":"text","current":""}]']);
    expect(mockApiRequest).toHaveBeenCalledWith("/form/fill", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Form fill suggestion"));
    consoleSpy.mockRestore();
  });

  it("handles form fill failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("LLM error"));
    await expect(formFillCommand.parseAsync(["node", "cli", "-r", "/p", "-i", "fill", "--fields", "[]"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// org member invite decline
// ---------------------------------------------------------------------------
describe("org member invite decline", () => {
  it("declines an invitation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ invitationPublicId: "inv1", status: "declined" });
    await orgMemberInviteDeclineCommand.parseAsync(["node", "cli", "-i", "inv1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/org/member/invite/decline", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("declined"));
    consoleSpy.mockRestore();
  });

  it("handles decline failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Invitation not found"));
    await expect(orgMemberInviteDeclineCommand.parseAsync(["node", "cli", "-i", "inv1"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// organization create
// ---------------------------------------------------------------------------
describe("organization create", () => {
  it("creates an organization", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ publicId: "org1", name: "Acme Corp", slug: "acme-corp", type: "business", createdAt: "2026-06-08" });
    await organizationCreateCommand.parseAsync(["node", "cli", "-n", "Acme Corp", "-s", "acme-corp"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/organization/create", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Organization created"));
    consoleSpy.mockRestore();
  });

  it("handles create failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Slug already taken"));
    await expect(organizationCreateCommand.parseAsync(["node", "cli", "-n", "Acme", "-s", "acme"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin credential set_secret
// ---------------------------------------------------------------------------
describe("plugin credential set_secret", () => {
  it("stores a credential", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginCredentialSetSecretCommand.parseAsync(["node", "cli", "-l", "listing1", "-a", "secret", "--secret", "my-secret"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/credential/set_secret", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Credential stored"));
    consoleSpy.mockRestore();
  });

  it("handles credential failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Listing not found"));
    await expect(pluginCredentialSetSecretCommand.parseAsync(["node", "cli", "-l", "l1", "-a", "secret"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin denylist
// ---------------------------------------------------------------------------
describe("plugin denylist add", () => {
  it("adds a server to the denylist", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginDenylistAddCommand.parseAsync(["node", "cli", "-s", "bad-server"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/denylist/add", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("bad-server"));
    consoleSpy.mockRestore();
  });

  it("handles denylist add failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Server not found"));
    await expect(pluginDenylistAddCommand.parseAsync(["node", "cli", "-s", "srv"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("plugin denylist remove", () => {
  it("removes a server from the denylist", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginDenylistRemoveCommand.parseAsync(["node", "cli", "-s", "bad-server"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/denylist/remove", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("bad-server"));
    consoleSpy.mockRestore();
  });

  it("handles denylist remove failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Entry not found"));
    await expect(pluginDenylistRemoveCommand.parseAsync(["node", "cli", "-s", "srv"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin org install bulk
// ---------------------------------------------------------------------------
describe("plugin org install bulk", () => {
  it("bulk installs plugins", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ installed: [{ catalogServerId: "srv1", orgListingId: "listing1", error: null }] });
    await pluginOrgInstallBulkCommand.parseAsync(["node", "cli", "--items", '[{"catalogServerId":"srv1"}]']);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/org/install_bulk", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1 succeeded"));
    consoleSpy.mockRestore();
  });

  it("reports partial failures", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ installed: [{ catalogServerId: "srv1", orgListingId: null, error: "Not found" }] });
    await pluginOrgInstallBulkCommand.parseAsync(["node", "cli", "--items", '[{"catalogServerId":"srv1"}]']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("0 succeeded, 1 failed"));
    consoleSpy.mockRestore();
  });

  it("handles bulk install failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Bad request"));
    await expect(pluginOrgInstallBulkCommand.parseAsync(["node", "cli", "--items", "[]"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin org list
// ---------------------------------------------------------------------------
describe("plugin org list", () => {
  it("lists org plugins", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      listings: [{ id: "l1", publicId: "pub1", name: "Slack", pluginType: "mcp_server", enabled: true }],
      denylist: [],
    });
    await pluginOrgListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Slack"));
    consoleSpy.mockRestore();
  });

  it("shows denylist when populated", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      listings: [],
      denylist: [{ id: "d1", serverName: "bad-server", pluginType: "mcp_server", reason: "Security risk" }],
    });
    await pluginOrgListCommand.parseAsync(["node", "cli"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Denylist"));
    consoleSpy.mockRestore();
  });

  it("handles list failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Unauthorized"));
    await expect(pluginOrgListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin org set_enabled
// ---------------------------------------------------------------------------
describe("plugin org set_enabled", () => {
  it("enables a plugin listing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginOrgSetEnabledCommand.parseAsync(["node", "cli", "-l", "listing1", "--enabled", "true"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/org/set_enabled", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("enabled"));
    consoleSpy.mockRestore();
  });

  it("disables a plugin listing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginOrgSetEnabledCommand.parseAsync(["node", "cli", "-l", "listing1", "--enabled", "false"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    consoleSpy.mockRestore();
  });

  it("handles set_enabled failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Listing not found"));
    await expect(pluginOrgSetEnabledCommand.parseAsync(["node", "cli", "-l", "l1", "--enabled", "true"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin registry remove
// ---------------------------------------------------------------------------
describe("plugin registry remove", () => {
  it("removes a registry", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginRegistryRemoveCommand.parseAsync(["node", "cli", "-r", "reg1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/registry/remove", expect.objectContaining({ method: "DELETE" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("reg1 removed"));
    consoleSpy.mockRestore();
  });

  it("handles remove failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Registry is global default"));
    await expect(pluginRegistryRemoveCommand.parseAsync(["node", "cli", "-r", "r1"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin registry sync
// ---------------------------------------------------------------------------
describe("plugin registry sync", () => {
  it("triggers a registry sync", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ accepted: true });
    await pluginRegistrySyncCommand.parseAsync(["node", "cli", "-r", "reg1"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/registry/sync", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Sync accepted"));
    consoleSpy.mockRestore();
  });

  it("reports sync not accepted", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ accepted: false });
    await pluginRegistrySyncCommand.parseAsync(["node", "cli", "-r", "reg1"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not accepted"));
    consoleSpy.mockRestore();
  });

  it("handles sync failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Registry not found"));
    await expect(pluginRegistrySyncCommand.parseAsync(["node", "cli", "-r", "reg1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin settings set_auth_alerts
// ---------------------------------------------------------------------------
describe("plugin settings set_auth_alerts", () => {
  it("updates auth alert settings", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: true });
    await pluginSettingsSetAuthAlertsCommand.parseAsync(["node", "cli", "--roles", "Owner,Admin"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/settings/set_auth_alerts", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("updated"));
    consoleSpy.mockRestore();
  });

  it("reports update failed when ok=false", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ ok: false });
    await pluginSettingsSetAuthAlertsCommand.parseAsync(["node", "cli", "--roles", "Owner"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Update failed"));
    consoleSpy.mockRestore();
  });

  it("handles failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(pluginSettingsSetAuthAlertsCommand.parseAsync(["node", "cli", "--roles", "Owner"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugin workspace set_enabled
// ---------------------------------------------------------------------------
describe("plugin workspace set_enabled", () => {
  it("enables a plugin for workspace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ workspaceServerId: "wsrv1" });
    await pluginWorkspaceSetEnabledCommand.parseAsync(["node", "cli", "-l", "listing1", "--enabled", "true"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/plugin/workspace/set_enabled", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("enabled"));
    consoleSpy.mockRestore();
  });

  it("disables a plugin for workspace (no server ID)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ workspaceServerId: null });
    await pluginWorkspaceSetEnabledCommand.parseAsync(["node", "cli", "-l", "listing1", "--enabled", "false"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    consoleSpy.mockRestore();
  });

  it("handles failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Listing not found"));
    await expect(pluginWorkspaceSetEnabledCommand.parseAsync(["node", "cli", "-l", "l1", "--enabled", "true"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// system install instructions
// ---------------------------------------------------------------------------
describe("system install instructions", () => {
  it("shows installation steps", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      client: "claude-code",
      steps: [
        { label: "Install the CLI", command: "npm install -g @oxagen/cli" },
        { label: "Authenticate", command: "oxagen auth login" },
      ],
    });
    await systemInstallInstructionsCommand.parseAsync(["node", "cli", "-c", "claude-code"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("claude-code"));
    consoleSpy.mockRestore();
  });

  it("handles fetch failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Unknown client"));
    await expect(systemInstallInstructionsCommand.parseAsync(["node", "cli", "-c", "unknown"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// user preferences read/write
// ---------------------------------------------------------------------------
describe("user preferences read", () => {
  it("reads user preferences", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: "balanced",
      defaultTextModel: "claude-haiku-4-5",
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    await userPreferencesReadCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/user/preferences/read", expect.objectContaining({ method: "GET" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("preferences"));
    consoleSpy.mockRestore();
  });

  it("shows optional fields when set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      fontSize: "large",
      density: "spacious",
      enterToSubmit: false,
      pendingPromptBehavior: "interrupt",
      defaultTextTier: "precise",
      defaultTextModel: "claude-sonnet-4-6",
      defaultImageModel: "gpt-image-1",
      defaultVideoModel: "veo-3.0",
    });
    await userPreferencesReadCommand.parseAsync(["node", "cli"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-image-1"));
    consoleSpy.mockRestore();
  });

  it("handles read failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Unauthorized"));
    await expect(userPreferencesReadCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("user preferences write", () => {
  it("updates user preferences", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      fontSize: "large",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });
    await userPreferencesWriteCommand.parseAsync(["node", "cli", "--font-size", "large"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/user/preferences/write", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("updated"));
    consoleSpy.mockRestore();
  });

  it("handles write failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Validation failed"));
    await expect(userPreferencesWriteCommand.parseAsync(["node", "cli", "--density", "bad"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workflow cancel / status
// ---------------------------------------------------------------------------
describe("workflow cancel", () => {
  it("cancels a workflow", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ cancelled: true });
    await workflowCancelCommand.parseAsync(["node", "cli", "-w", "wfr_abc"]);
    expect(mockApiRequest).toHaveBeenCalledWith("/workflow/cancel", expect.objectContaining({ method: "POST" }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
    consoleSpy.mockRestore();
  });

  it("reports workflow could not be cancelled", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ cancelled: false });
    await workflowCancelCommand.parseAsync(["node", "cli", "-w", "wfr_abc"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("could not be cancelled"));
    consoleSpy.mockRestore();
  });

  it("handles cancel failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Not found"));
    await expect(workflowCancelCommand.parseAsync(["node", "cli", "-w", "wfr_abc"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("workflow status", () => {
  it("shows workflow status and tasks", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({
      workflow: { id: "wf1", publicId: "wfr_abc", title: "Research task", status: "running", totalTasks: 5, completedTasks: 3, failedTasks: 0 },
      tasks: [
        { id: "t1", title: "Gather data", status: "completed" },
        { id: "t2", title: "Analyze data", status: "running" },
      ],
    });
    await workflowStatusCommand.parseAsync(["node", "cli", "-w", "wfr_abc"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("running"));
    consoleSpy.mockRestore();
  });

  it("handles status fetch failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("process.exit"); });
    mockApiRequest.mockRejectedValueOnce(new Error("Workflow not found"));
    await expect(workflowStatusCommand.parseAsync(["node", "cli", "-w", "wfr_xyz"])).rejects.toThrow();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: ApiError paths and edge cases
// These tests exercise the `err instanceof ApiError ? ... : String(err)` branch
// in catch blocks (currently always false), plus empty/optional data branches.
// ---------------------------------------------------------------------------
describe("branch coverage: ApiError error paths", () => {
  it("automation list returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(403, "Forbidden");
    await expect(automationListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Forbidden");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("automation create returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(400, "Name required");
    await expect(automationCreateCommand.parseAsync(["node", "cli", "-n", "A"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Name required");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("automation trigger returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(404, "Automation not found");
    await expect(automationTriggerCommand.parseAsync(["node", "cli", "-a", "a1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Automation not found");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("billing credits purchase returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(402, "Payment failed");
    await expect(billingCreditsPurchaseCommand.parseAsync(["node", "cli", "-a", "10"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Payment failed");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("billing subscription read returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(404, "Subscription not found");
    await expect(billingSubscriptionReadCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Subscription not found");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("document list returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(403, "Access denied");
    await expect(documentListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Access denied");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("workspace member list returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(403, "Not a member");
    await expect(workspaceMemberListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Not a member");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("workflow cancel returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(404, "Workflow not found");
    await expect(workflowCancelCommand.parseAsync(["node", "cli", "-w", "wfr_abc"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Workflow not found");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("workflow status returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(404, "Run expired");
    await expect(workflowStatusCommand.parseAsync(["node", "cli", "-w", "wfr_abc"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Run expired");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("user preferences read returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(401, "Unauthorized");
    await expect(userPreferencesReadCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Unauthorized");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("user preferences write returns ApiError message", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(400, "Invalid font size");
    await expect(userPreferencesWriteCommand.parseAsync(["node", "cli", "--font-size", "xxx"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Invalid font size");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });
});

describe("branch coverage: empty/optional data branches", () => {
  it("automation list shows empty message when no automations found", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce([]);
    await automationListCommand.parseAsync(["node", "cli"]);
    expect(consoleSpy).toHaveBeenCalledWith("No automations found.");
    consoleSpy.mockRestore();
  });

  it("automation list with workspace option", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce([{ id: "a1", name: "Test", status: "active", triggers: [] }]);
    await automationListCommand.parseAsync(["node", "cli", "-w", "ws1"]);
    expect(mockApiRequest).toHaveBeenCalledWith(expect.stringContaining("workspace_id=ws1"), expect.anything());
    consoleSpy.mockRestore();
  });

  it("automation list shows 'none' when triggers are empty", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce([{ id: "a1", name: "Untriggered", status: "active", triggers: [] }]);
    await automationListCommand.parseAsync(["node", "cli"]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("triggers=none"));
    consoleSpy.mockRestore();
  });

  it("image create with save-to option", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ id: "img1", url: "https://cdn.example.com/img.png", created_at: "2026-06-08", workspace_id: "ws1" });
    await imageCreateCommand.parseAsync(["node", "cli", "-p", "A cat"]);
    consoleSpy.mockRestore();
  });

  it("conversation chat ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(401, "Not authenticated");
    await expect(conversationChatCommand.parseAsync(["node", "cli", "-m", "Hello"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Not authenticated");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("workspace list ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(403, "Org not found");
    await expect(workspaceListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Org not found");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("org list ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(401, "Token expired");
    await expect(orgListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Token expired");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("api-key create ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(429, "Rate limit exceeded");
    await expect(apiKeyCreateCommand.parseAsync(["node", "cli", "mykey"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Rate limit exceeded");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("plugin list ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(403, "Permission denied");
    await expect(pluginListCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Permission denied");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("billing status ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(402, "Billing error");
    await expect(billingStatusCommand.parseAsync(["node", "cli"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Billing error");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("chat send ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(503, "Service unavailable");
    await expect(chatSendCommand.parseAsync(["node", "cli", "test"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Service unavailable");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("document read ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(404, "Document not found");
    await expect(documentReadCommand.parseAsync(["node", "cli", "-d", "doc1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Document not found");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });

  it("notification list with empty results", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockApiRequest.mockResolvedValueOnce({ notifications: [] });
    await notificationsListCommand.parseAsync(["node", "cli"]);
    consoleSpy.mockRestore();
  });

  it("workflow run ApiError path", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => { throw new Error("exit"); });
    mockApiError(400, "Invalid workflow spec");
    await expect(workflowRunCommand.parseAsync(["node", "cli", "-w", "wf1"])).rejects.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Error: Invalid workflow spec");
    consoleSpy.mockRestore(); exitSpy.mockRestore();
  });
});
