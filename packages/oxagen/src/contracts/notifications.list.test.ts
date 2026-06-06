import { describe, it, expect } from "vitest";
import { notificationsList } from "./notifications.list";

describe("notifications.list contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsList.name).toBe("notifications.list");
    expect(notificationsList.domain).toBe("notifications");
  });

  it("parses valid input with defaults", () => {
    const parsed = notificationsList.input.parse({});
    expect(parsed.unreadOnly).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit above 100", () => {
    expect(() => notificationsList.input.parse({ limit: 101 })).toThrow();
  });

  it("output schema accepts a valid notification list", () => {
    const parsed = notificationsList.output.parse({
      notifications: [
        {
          id: "uuid-1",
          publicId: "ntf_abc",
          kind: "security",
          title: "Reconnect GitHub",
          body: null,
          deepLink: "/reauth/x",
          unread: true,
          archived: false,
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
    });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.unreadCount).toBe(1);
  });
});
