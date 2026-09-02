import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
vi.mock("@oxagen/database", () => {
  const mockTx = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) =>
            Promise.resolve([{ name: "Acme Inc.", settings: {} }]),
        }),
      }),
    }),
    // emailedAt stamping after a successful send: tx.update(...).set(...).where(...)
    update: (_t: unknown) => ({
      set: (_v: unknown) => ({
        where: (_w: unknown) => Promise.resolve(undefined),
      }),
    }),
  };
  return {
    schema: {
      orgUsers: "orgUsers_sentinel",
      organizations: "orgs_sentinel",
      users: "users_sentinel",
      notifications: "notifications_sentinel",
    },
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    ),
  };
});

// ── Sibling mock ─────────────────────────────────────────────────────────────
// Use vi.hoisted so these are available inside the vi.mock factory closures.
const { mockCreateNotification, mockSendEmail } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue({
    id: "notif-1",
    publicId: "ntf_X",
    createdAt: new Date(),
  }),
  mockSendEmail: vi.fn().mockResolvedValue({
    id: "msg-1",
    accepted: ["owner@acme.com"],
    rejected: [],
  }),
}));

vi.mock("./create-notification", () => ({
  createNotification: mockCreateNotification,
}));

// ── sendEmail mock ────────────────────────────────────────────────────────────
vi.mock("../send-email", () => ({ sendEmail: mockSendEmail }));

import { notifyOrgManagers } from "./notify-org-managers";

describe("notifyOrgManagers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("creates one notification per resolved recipient (Owner + Admin by default)", async () => {
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "Token expired.",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      // stub: inject recipients directly for unit isolation
      _recipientsOverride: [
        { userId: "user-owner", email: "owner@acme.com" },
        { userId: "user-admin", email: "admin@acme.com" },
      ],
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner", orgId: "org-1" }),
    );
  });

  it("skips email when send_email setting is false", async () => {
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      emailDisabled: true,
      _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("creates in-app notification even when email fails (log-and-continue)", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    await expect(
      notifyOrgManagers({
        orgId: "org-1",
        kind: "security",
        title: "Reconnect GitHub",
        deepLink: "/reauth/porg_123",
        emailHtml: "<p>Reconnect</p>",
        _recipientsOverride: [
          { userId: "user-owner", email: "owner@acme.com" },
        ],
      }),
    ).resolves.not.toThrow();
    // In-app notification must still have been created.
    expect(mockCreateNotification).toHaveBeenCalledOnce();
  });

  it("notifies exactly the injected recipients and no one else", async () => {
    // The override path bypasses role resolution entirely, so this asserts only
    // that the loop honours the injected list verbatim. Role filtering itself is
    // covered against the real DB-resolution branch in
    // notify-org-managers.production.test.ts ("honors custom alert roles").
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Test",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
      _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner" }),
    );
  });
});
