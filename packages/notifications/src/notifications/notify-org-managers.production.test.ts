import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mutable DB state ───────────────────────────────────────────────────────────
// Hoisted so the vi.mock factory closures and the tests share the same object.
// Each test sets the rows the (mocked) production queries should resolve to,
// exercising the real DB-resolution branch of notifyOrgManagers (no override).
const dbState = vi.hoisted(() => ({
  orgSettings: {} as Record<string, unknown>,
  orgUserRows: [] as { userId: string }[],
  userRows: [] as { id: string; email: string }[],
}));

// Schema sentinels — referenced by identity in the mock to route each query.
const SENTINEL = vi.hoisted(() => ({
  organizations: "orgs_sentinel" as const,
  orgUsers: "orgUsers_sentinel" as const,
  users: "users_sentinel" as const,
  notifications: "notifications_sentinel" as const,
}));

// ── @oxagen/database mock ──────────────────────────────────────────────────────
// Routes by the table sentinel passed to .from():
//   organizations → .where().limit(1) → [{ settings }]
//   orgUsers      → .where()          → [{ userId }]
//   users         → .where()          → [{ id, email }]
// update().set().where() resolves undefined (emailedAt stamping).
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (_w: unknown) => {
          if (table === SENTINEL.organizations) {
            return {
              limit: (_n: number) =>
                Promise.resolve([{ settings: dbState.orgSettings }]),
            };
          }
          if (table === SENTINEL.orgUsers) {
            return Promise.resolve(dbState.orgUserRows);
          }
          if (table === SENTINEL.users) {
            return Promise.resolve(dbState.userRows);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    update: (_t: unknown) => ({
      set: (_v: unknown) => ({
        where: (_w: unknown) => Promise.resolve(undefined),
      }),
    }),
  });
  return {
    schema: {
      organizations: SENTINEL.organizations,
      orgUsers: SENTINEL.orgUsers,
      users: SENTINEL.users,
      notifications: SENTINEL.notifications,
    },
    withSystemDb: vi.fn(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        fn(makeTx()),
    ),
  };
});

// ── Sibling mocks ──────────────────────────────────────────────────────────────
const { mockCreateNotification, mockSendEmail } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockSendEmail: vi.fn(),
}));
vi.mock("./create-notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("../send-email", () => ({ sendEmail: mockSendEmail }));

import { notifyOrgManagers } from "./notify-org-managers";

describe("notifyOrgManagers — production DB-resolution path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgSettings = {};
    dbState.orgUserRows = [];
    dbState.userRows = [];
    mockCreateNotification.mockResolvedValue({
      id: "notif-1",
      publicId: "ntf_X",
      createdAt: new Date(),
    });
    mockSendEmail.mockResolvedValue({
      id: "msg-1",
      accepted: ["owner@acme.com"],
      rejected: [],
    });
  });

  it("resolves recipients from the DB (default Owner/Admin roles), notifies and emails each, and stamps emailedAt", async () => {
    dbState.orgUserRows = [{ userId: "u1" }, { userId: "u2" }];
    dbState.userRows = [
      { id: "u1", email: "owner@acme.com" },
      { id: "u2", email: "admin@acme.com" },
    ];

    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "Token expired.",
      deepLink: "/reauth/x",
      emailHtml: "<p>Reconnect</p>",
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        orgId: "org-1",
        kind: "security",
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@acme.com",
        subject: "Reconnect GitHub",
        text: "Token expired.",
        html: "<p>Reconnect</p>",
      }),
    );
  });

  it("falls back to the title for email text when no body is provided", async () => {
    dbState.orgUserRows = [{ userId: "u1" }];
    dbState.userRows = [{ id: "u1", email: "owner@acme.com" }];

    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "No-body alert",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "No-body alert",
        text: "No-body alert",
      }),
    );
  });

  it("honors custom alert roles from org settings", async () => {
    dbState.orgSettings = { mcp_auth_alerts: { roles: ["Owner"] } };
    dbState.orgUserRows = [{ userId: "u1" }];
    dbState.userRows = [{ id: "u1", email: "owner@acme.com" }];

    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Custom roles",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
    });

    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("skips email when org settings send_email is false (in-app notification still created)", async () => {
    dbState.orgSettings = { mcp_auth_alerts: { send_email: false } };
    dbState.orgUserRows = [{ userId: "u1" }];
    dbState.userRows = [{ id: "u1", email: "owner@acme.com" }];

    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Email disabled",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
    });

    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns early and creates nothing when no org users match the alert roles", async () => {
    dbState.orgUserRows = [];

    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "No recipients",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
    });

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("logs and continues to the next recipient when in-app notification creation fails", async () => {
    dbState.orgUserRows = [{ userId: "u1" }, { userId: "u2" }];
    dbState.userRows = [
      { id: "u1", email: "a@x.com" },
      { id: "u2", email: "b@x.com" },
    ];
    mockCreateNotification
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        id: "notif-2",
        publicId: "ntf_2",
        createdAt: new Date(),
      });

    await expect(
      notifyOrgManagers({
        orgId: "org-1",
        kind: "security",
        title: "Partial failure",
        deepLink: "/reauth/x",
        emailHtml: "<p>x</p>",
      }),
    ).resolves.toBeUndefined();

    // Both recipients attempted; only the second produced an email.
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "b@x.com" }),
    );
  });
});
