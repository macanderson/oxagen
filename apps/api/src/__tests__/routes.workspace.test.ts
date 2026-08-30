/**
 * Unit tests for workspace/org/user route handlers:
 *   workspace.create, workspace.model.settings.read,
 *   workspace.model.settings.write, organization.create,
 *   org.member.add, org.member.invite.accept, org.member.invite.decline,
 *   org.member.remove, org.member.role.change,
 *   user.preferences.read, user.preferences.write,
 *   notifications.list, notifications.mark
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";
const V1 = "/v1";

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body: unknown, base = BASE): Request {
  return makeRequest(`${base}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, base = BASE): Request {
  return makeRequest(`${base}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── organization.create ───────────────────────────────────────────────────

describe("organization.create route", () => {
  const PATH = "/organizations";

  it("happy path: 201 with org", async () => {
    const invokeResult = {
      publicId: "org-1",
      name: "Acme Corp",
      slug: "acme",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { name: "Acme Corp", slug: "acme" }, V1),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_org'", async () => {
    await app.fetch(post(PATH, { name: "Acme Corp", slug: "acme-corp" }, V1));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_org");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("Acme Corp");
    expect(body.slug).toBe("acme-corp");
  });

  it("invalid slug (uppercase) → 400", async () => {
    const res = await app.fetch(post(PATH, { name: "Acme", slug: "Acme" }, V1));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("slug too short → 400", async () => {
    const res = await app.fetch(post(PATH, { name: "X", slug: "x" }, V1));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── workspace.create ──────────────────────────────────────────────────────

describe("workspace.create route", () => {
  const PATH = "/workspaces";

  it("happy path: 201 with workspace", async () => {
    const invokeResult = {
      publicId: "ws-1",
      name: "Dev Workspace",
      slug: "dev",
    };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(
      post(PATH, { name: "Dev Workspace", slug: "dev" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_workspace'", async () => {
    await app.fetch(post(PATH, { name: "Dev", slug: "dev" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_workspace");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.slug).toBe("dev");
  });

  it("invalid slug (spaces) → 400", async () => {
    const res = await app.fetch(
      post(PATH, { name: "X", slug: "my workspace" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── workspace.model.settings.read ────────────────────────────────────────

describe("workspace.model.settings.read route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path GET: 200", async () => {
    const invokeResult = {
      defaultTextTier: "balanced",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_model_settings' and empty input", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_model_settings");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── workspace.model.settings.write ───────────────────────────────────────

describe("workspace.model.settings.write route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path PATCH: 200", async () => {
    const invokeResult = {
      defaultTextTier: "precise",
      defaultTextModel: "claude-4",
      defaultImageModel: null,
      defaultVideoModel: null,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ defaultTextTier: "precise" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'update_model_settings'", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ defaultTextTier: "fast" }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_model_settings");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.defaultTextTier).toBe("fast");
  });
});

// ── org.member.add ────────────────────────────────────────────────────────

describe("org.member.add route", () => {
  const PATH = "/org/members";

  it("happy path: 201 with invitation", async () => {
    const invokeResult = {
      invitationId: "inv-1",
      email: "alice@example.com",
      role: "Member",
      status: "pending",
      expiresAt: null,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { email: "alice@example.com", role: "Member" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'add_org_member'", async () => {
    await app.fetch(post(PATH, { email: "bob@example.com", role: "Admin" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("add_org_member");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.email).toBe("bob@example.com");
    expect(body.role).toBe("Admin");
  });

  it("invalid email → 400", async () => {
    const res = await app.fetch(
      post(PATH, { email: "not-an-email", role: "Member" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── org.member.invite.accept ─────────────────────────────────────────────

describe("org.member.invite.accept route", () => {
  const PATH = "/org/invitations/accept";

  it("happy path: 200", async () => {
    const invokeResult = {
      orgUserId: "ou-1",
      orgId: "org-1",
      role: "Member",
      joinedAt: "2024-01-01T00:00:00Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, { invitationPublicId: "inv_abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'accept_member_invite'", async () => {
    await app.fetch(post(PATH, { invitationPublicId: "inv_xyz" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("accept_member_invite");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.invitationPublicId).toBe("inv_xyz");
  });
});

// ── org.member.invite.decline ────────────────────────────────────────────

describe("org.member.invite.decline route", () => {
  const PATH = "/org/invitations/decline";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      invitationPublicId: "inv_abc",
      status: "declined",
    });
    const res = await app.fetch(post(PATH, { invitationPublicId: "inv_abc" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'decline_member_invite'", async () => {
    await app.fetch(post(PATH, { invitationPublicId: "inv_xyz" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("decline_member_invite");
  });
});

// ── org.member.remove ────────────────────────────────────────────────────

describe("org.member.remove route", () => {
  const PATH = "/org/members/remove";

  it("happy path DELETE: 200", async () => {
    mocks.invoke.mockResolvedValue({
      removed: true,
      targetUserId: "usr-1",
      orgId: "org-1",
    });
    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: "usr-1" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'remove_org_member'", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: "usr-2" }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("remove_org_member");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.targetUserId).toBe("usr-2");
  });
});

// ── org.member.role.change ───────────────────────────────────────────────

describe("org.member.role.change route", () => {
  const PATH = "/org/members/role";

  it("happy path PATCH: 200", async () => {
    mocks.invoke.mockResolvedValue({
      changed: true,
      targetUserId: "usr-1",
      orgId: "org-1",
    });
    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: "usr-1", newRole: "Admin" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'change_member_role'", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: "usr-1", newRole: "Billing" }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("change_member_role");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.newRole).toBe("Billing");
  });
});

// ── user.preferences.read ────────────────────────────────────────────────

describe("user.preferences.read route", () => {
  const PATH = "/user/preferences/read";

  it("happy path GET: 200 with preferences", async () => {
    const invokeResult = {
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH, V1));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_user_preferences' and empty input", async () => {
    await app.fetch(get(PATH, V1));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_user_preferences");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── user.preferences.write ───────────────────────────────────────────────

describe("user.preferences.write route", () => {
  const PATH = "/user/preferences/write";

  it("happy path PATCH: 200", async () => {
    mocks.invoke.mockResolvedValue({ fontSize: "large" });
    const res = await app.fetch(
      makeRequest(`${V1}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ fontSize: "large" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'update_user_preferences'", async () => {
    await app.fetch(
      makeRequest(`${V1}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ density: "compact", enterToSubmit: false }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_user_preferences");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.density).toBe("compact");
    expect(body.enterToSubmit).toBe(false);
  });
});

// ── notifications.list ────────────────────────────────────────────────────

describe("notifications.list route", () => {
  const PATH = "/notifications";

  it("happy path GET: 200 with notifications", async () => {
    mocks.invoke.mockResolvedValue({ notifications: [] });
    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: [] });
  });

  it("calls invoke with 'list_notifications' and defaults", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_notifications");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    // defaults: unreadOnly=false, limit=50
    expect(body.unreadOnly).toBe(false);
    expect(body.limit).toBe(50);
  });

  it("?unreadOnly=true → passes true", async () => {
    await app.fetch(
      makeRequest(`${BASE}/notifications?unreadOnly=true`, {
        headers: authHeaders(),
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.unreadOnly).toBe(true);
  });

  it("?unreadOnly=false → passes false", async () => {
    await app.fetch(
      makeRequest(`${BASE}/notifications?unreadOnly=false`, {
        headers: authHeaders(),
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.unreadOnly).toBe(false);
  });

  it("?limit=10 → parseInt passes 10 to invoke", async () => {
    await app.fetch(
      makeRequest(`${BASE}/notifications?limit=10`, {
        headers: authHeaders(),
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.limit).toBe(10);
  });

  it("?limit=abc → parseInt NaN → Zod validation → 400, invoke not called", async () => {
    const res = await app.fetch(
      makeRequest(`${BASE}/notifications?limit=abc`, {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── notifications.mark ────────────────────────────────────────────────────

describe("notifications.mark route", () => {
  const PATH = "/notifications/mark";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });
    const res = await app.fetch(post(PATH, { id: "ntf_abc", read: true }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'mark_notification'", async () => {
    await app.fetch(post(PATH, { id: "ntf_xyz", archived: true }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("mark_notification");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.id).toBe("ntf_xyz");
    expect(body.archived).toBe(true);
  });

  it("missing id → 400", async () => {
    const res = await app.fetch(post(PATH, { read: true }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
