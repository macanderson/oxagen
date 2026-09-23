import { beforeEach, describe, it, expect, vi } from "vitest";

const seams = vi.hoisted(() => ({ org: vi.fn(), workspace: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const mockRows = [
  {
    id: "uuid-1",
    publicId: "ntf_A",
    kind: "approval",
    event: "approval.requested",
    title: "Reconnect GitHub",
    body: null,
    deepLink: "/reauth/x",
    unread: true,
    archived: false,
    createdAt: new Date("2026-06-01"),
  },
];

vi.mock("@oxagen/database", () => {
  let call = 0;
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    schema: {
      notifications: {
        userId: "userId_col",
        orgId: "orgId_col",
        workspaceId: "workspaceId_col",
        archived: "archived_col",
        unread: "unread_col",
        createdAt: "createdAt_col",
        id: "id_col",
        publicId: "publicId_col",
        kind: "kind_col",
        event: "event_col",
        title: "title_col",
        body: "body_col",
        deepLink: "deepLink_col",
      },
    },
    withTenantDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      call = 0;
      return fn({
        select: () => {
          call++;
          if (call % 2 === 1) {
            // list query
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({ limit: () => Promise.resolve(mockRows) }),
                }),
              }),
            };
          }
          // count query
          return {
            from: () => ({
              where: () => Promise.resolve([{ n: 1 }]),
            }),
          };
        },
      });
    }),
  };
  return {
    ...dbMock,
    withTenantDb: (...args: Parameters<typeof dbMock.withTenantDb>) => {
      seams.workspace();
      return dbMock.withTenantDb(...args);
    },
    withOrgDb: (...args: Parameters<typeof dbMock.withTenantDb>) => {
      seams.org();
      return dbMock.withTenantDb(...args);
    },
  };
});

// Stub drizzle helpers used in the handler

import { handler } from "./notification.list";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";

describe("notifications.list handler", () => {
  it("returns notifications and unreadCount", async () => {
    const ctx = {
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      apiKeyId: null,
      requestId: "req-1",
      surface: "api" as const,
      messageId: null,
    };
    const result = (await handler({ unreadOnly: false, limit: 50 }, ctx)) as {
      notifications: unknown[];
      unreadCount: number;
    };
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      publicId: "ntf_A",
      kind: "approval",
      event: "approval.requested",
    });
    expect(result.unreadCount).toBeGreaterThanOrEqual(0);
    expect(seams.workspace).toHaveBeenCalledOnce();
    expect(seams.org).not.toHaveBeenCalled();
  });

  it("reads organization notifications without entering a workspace scope", async () => {
    await handler(
      { unreadOnly: false, limit: 50 },
      {
        orgId: "org-1",
        workspaceId: ORG_ONLY_WORKSPACE_ID,
        userId: "user-1",
        apiKeyId: null,
        requestId: "req-1",
        surface: "api",
        messageId: null,
      },
    );
    expect(seams.org).toHaveBeenCalledOnce();
    expect(seams.workspace).not.toHaveBeenCalled();
  });

  it("throws when userId is absent", async () => {
    const ctx = {
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: null,
      apiKeyId: null,
      requestId: "req-1",
      surface: "api" as const,
      messageId: null,
    };
    await expect(
      handler({ unreadOnly: false, limit: 50 }, ctx),
    ).rejects.toThrow("userId is required");
  });
});
