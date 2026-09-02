import { describe, it, expect, vi } from "vitest";

const mockRows = [
  {
    id: "uuid-1",
    publicId: "ntf_A",
    kind: "security",
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
  return {
    schema: {
      notifications: {
        userId: "userId_col",
        archived: "archived_col",
        unread: "unread_col",
        createdAt: "createdAt_col",
        id: "id_col",
        publicId: "publicId_col",
        kind: "kind_col",
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
});

// Stub drizzle helpers used in the handler

import { handler } from "./notification.list";

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
    expect(result.unreadCount).toBeGreaterThanOrEqual(0);
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
