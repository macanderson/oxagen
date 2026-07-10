/**
 * notifications.test.ts — unit tests for listNotificationsAction and
 * markNotificationAction.
 *
 * Mock seam: @oxagen/oxagen → invoke. Both actions build a capability context,
 * call invoke(), and parse the output. We verify the correct capability name
 * is called, the context is wired correctly, and errors propagate cleanly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test.
// ---------------------------------------------------------------------------
vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: vi.fn(),
  assertOrgMember: vi.fn(),
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

// Mock contracts with minimal parse that passes through the object
vi.mock("@oxagen/oxagen/contracts/notification.list", () => ({
  notificationsList: {
    name: "list_notifications",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

vi.mock("@oxagen/oxagen/contracts/notification.mark", () => ({
  notificationsMark: {
    name: "mark_notification",
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));

import { listNotificationsAction, markNotificationAction } from "./notifications";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mockSession = { user: { id: "user-1" } };
const mockOrg = { id: "org-abc", publicId: "pub-org", name: "Acme", slug: "acme" };
const mockWs = { id: "ws-xyz", publicId: "pub-ws", orgId: "org-abc", name: "Prod", slug: "prod" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("listNotificationsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
    vi.mocked(resolveWorkspace).mockResolvedValue(mockWs as never);
    vi.mocked(assertOrgMember).mockResolvedValue(undefined);
  });

  it("invokes notifications.list with correct capability name", async () => {
    vi.mocked(invoke).mockResolvedValue({ notifications: [] });
    await listNotificationsAction("acme", "prod");
    const [capName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capName).toBe("list_notifications");
  });

  it("passes unreadOnly and limit to the capability", async () => {
    vi.mocked(invoke).mockResolvedValue({ notifications: [] });
    await listNotificationsAction("acme", "prod", { unreadOnly: true, limit: 10 });
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { unreadOnly: boolean }).unreadOnly).toBe(true);
    expect((input as { limit: number }).limit).toBe(10);
  });

  it("uses default unreadOnly: false, limit: 50 when no opts passed", async () => {
    vi.mocked(invoke).mockResolvedValue({ notifications: [] });
    await listNotificationsAction("acme", "prod");
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { unreadOnly: boolean }).unreadOnly).toBe(false);
    expect((input as { limit: number }).limit).toBe(50);
  });

  it("wires orgId, workspaceId, userId, surface into ctx", async () => {
    vi.mocked(invoke).mockResolvedValue({ notifications: [] });
    await listNotificationsAction("acme", "prod");
    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.orgId).toBe("org-abc");
    expect(ctx.workspaceId).toBe("ws-xyz");
    expect(ctx.userId).toBe("user-1");
    expect(ctx.surface).toBe("app");
    expect(ctx.apiKeyId).toBeNull();
  });

  it("asserts org membership before invoking", async () => {
    vi.mocked(invoke).mockResolvedValue({ notifications: [] });
    await listNotificationsAction("acme", "prod");
    expect(assertOrgMember).toHaveBeenCalledWith("org-abc", "user-1");
  });

  it("propagates errors from getSessionOrRedirect", async () => {
    vi.mocked(getSessionOrRedirect).mockRejectedValue(new Error("unauthenticated"));
    await expect(listNotificationsAction("acme", "prod")).rejects.toThrow("unauthenticated");
  });

  it("propagates errors from invoke", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler error"));
    await expect(listNotificationsAction("acme", "prod")).rejects.toThrow("handler error");
  });
});

describe("markNotificationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
    vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
    vi.mocked(resolveWorkspace).mockResolvedValue(mockWs as never);
    vi.mocked(assertOrgMember).mockResolvedValue(undefined);
  });

  it("invokes notifications.mark with correct capability name", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "notif-1", read: true });
    await markNotificationAction("acme", "prod", "notif-1", { read: true });
    const [capName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capName).toBe("mark_notification");
  });

  it("passes id and read flag to the capability input", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "notif-1", read: true });
    await markNotificationAction("acme", "prod", "notif-1", { read: true });
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { id: string }).id).toBe("notif-1");
    expect((input as { read: boolean }).read).toBe(true);
  });

  it("passes archived flag to the capability input", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "n-2", archived: true });
    await markNotificationAction("acme", "prod", "n-2", { archived: true });
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { archived: boolean }).archived).toBe(true);
  });

  it("wires ctx correctly", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "n-3", read: false });
    await markNotificationAction("acme", "prod", "n-3");
    const [, , ctx] = vi.mocked(invoke).mock.calls[0]!;
    expect(ctx.orgId).toBe("org-abc");
    expect(ctx.workspaceId).toBe("ws-xyz");
    expect(ctx.userId).toBe("user-1");
  });

  it("propagates errors from invoke", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("mark error"));
    await expect(markNotificationAction("acme", "prod", "notif-x")).rejects.toThrow("mark error");
  });
});
