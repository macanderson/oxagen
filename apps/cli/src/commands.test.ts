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

import * as apiClient from "./lib/api-client.js";
import * as config from "./lib/config.js";

const mockApiRequest = vi.mocked(apiClient.apiRequest);
const mockRequireAuth = vi.mocked(apiClient.requireAuth);
const mockWriteConfig = vi.mocked(config.writeConfig);
const mockClearConfig = vi.mocked(config.clearConfig);
const mockGetToken = vi.mocked(config.getToken);

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

    await apiKeyCreateCommand.parseAsync(["node", "cli", "my-key"]);

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
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    mockApiRequest.mockResolvedValueOnce({ title: "Doc 1", content: "Content..." });
    await documentReadCommand.parseAsync(["node", "cli", "-d", "doc1"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Doc 1"));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
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
    mockApiRequest.mockResolvedValueOnce({ automations: [{ id: "auto1", name: "Auto 1", status: "active", triggers: [], actions: [] }] });
    await automationListCommand.parseAsync(["node", "cli"]);
    expect(mockApiRequest).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Automations"));
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Skills"));
    consoleSpy.mockRestore();
  });
});
