/**
 * Unit tests for the workspace, privacy, and api.key routes:
 *   workspace.member.list, workspace.invite.send,
 *   workspace.model.settings.read, workspace.model.settings.write,
 *   privacy.data.erase, privacy.data.export,
 *   api.key.rotate
 *
 * The automation, skill, code.* and research.swarm blocks that shared this file
 * went with their capabilities in ADR-041's runtime excision.
 *
 * Pattern: mock at the adapter seam, assert happy path forwards invoke result
 * as JSON, invoke called once with correct contract name + surface "api".
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

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
});

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

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

function patch(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "PATCH",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── automation.list ───────────────────────────────────────────────────────────

describe("workspace.member.list route", () => {
  const PATH = "/workspace/member/list";

  it("happy path GET: returns 200 with members", async () => {
    mocks.invoke.mockResolvedValue([
      {
        id: "usr-1",
        email: "alice@test.com",
        role: "admin",
        joined_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'list_workspace_members' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_workspace_members");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?workspace_id is forwarded to invoke", async () => {
    await app.fetch(get(`${PATH}?workspace_id=ws-1`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workspace_id).toBe("ws-1");
  });

  it("no ?workspace_id → workspace_id is undefined in invoke input", async () => {
    await app.fetch(get(PATH));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workspace_id).toBeUndefined();
  });
});

// ── workspace.invite.send ─────────────────────────────────────────────────────

describe("workspace.invite.send route", () => {
  const PATH = "/workspace/invite/send";

  it("happy path POST: returns 200 with invite", async () => {
    mocks.invoke.mockResolvedValue({
      id: "inv-1",
      status: "pending",
      expires_at: "2026-07-28T00:00:00.000Z",
    });

    const res = await app.fetch(post(PATH, { email: "bob@test.com" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'send_workspace_invite' and surface 'api'", async () => {
    await app.fetch(post(PATH, { email: "carol@test.com", role: "admin" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("send_workspace_invite");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes email and optional role/message to invoke", async () => {
    await app.fetch(
      post(PATH, {
        email: "dan@test.com",
        role: "member",
        message: "Join us!",
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.email).toBe("dan@test.com");
    expect(body.role).toBe("member");
    expect(body.message).toBe("Join us!");
  });

  it("invalid email → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── workspace.model.settings.read ────────────────────────────────────────────

describe("workspace.model.settings.read route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path GET: returns 200 with settings", async () => {
    mocks.invoke.mockResolvedValue({
      defaultTextTier: "balanced",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_model_settings' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_model_settings");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes empty input to invoke", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── workspace.model.settings.write ───────────────────────────────────────────

describe("workspace.model.settings.write route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path PATCH: returns 200 with updated settings", async () => {
    mocks.invoke.mockResolvedValue({
      defaultTextTier: "fast",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });

    const res = await app.fetch(patch(PATH, { defaultTextTier: "fast" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'update_model_settings' and surface 'api'", async () => {
    await app.fetch(patch(PATH, { defaultTextModel: "claude-3-5-haiku" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_model_settings");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes optional model fields to invoke", async () => {
    await app.fetch(
      patch(PATH, { defaultTextTier: "precise", defaultImageModel: null }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.defaultTextTier).toBe("precise");
    expect(body.defaultImageModel).toBeNull();
  });
});

// ── privacy.data.erase ────────────────────────────────────────────────────────

describe("privacy.data.erase route", () => {
  const PATH = "/privacy/erase";
  const VALID_BODY = { scope: "user", confirm: true };

  it("happy path POST: returns 202 with erasure request", async () => {
    const invokeResult = {
      requestId: "55555555-5555-5555-5555-555555555555",
      status: "queued",
      effectiveAt: "2026-07-05T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'erase_data' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("erase_data");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes scope and confirm to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("user");
    expect(body.confirm).toBe(true);
  });

  it("missing confirm → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { scope: "user" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid scope → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { scope: "workspace", confirm: true }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── privacy.data.export ───────────────────────────────────────────────────────

describe("privacy.data.export route", () => {
  const PATH = "/privacy/export";

  it("happy path POST: returns 202 with export request", async () => {
    const invokeResult = {
      exportId: "66666666-6666-6666-6666-666666666666",
      status: "queued",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { scope: "user" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'export_data' and surface 'api'", async () => {
    await app.fetch(post(PATH, { scope: "user" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("export_data");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes scope and optional orgId to invoke", async () => {
    const orgId = "77777777-7777-7777-7777-777777777777";
    await app.fetch(post(PATH, { scope: "org", orgId }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("org");
    expect(body.orgId).toBe(orgId);
  });

  it("invalid scope → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { scope: "all" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── code.diff ─────────────────────────────────────────────────────────────────

describe("api.key.rotate route", () => {
  const PATH = "/api-keys/rotate";

  it("happy path POST: returns 201 with new key", async () => {
    const invokeResult = {
      publicId: "aky-new",
      keyHint: "oxk_...",
      revokedAt: "2026-06-28T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { keyPublicId: "aky-old" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'rotate_api_key' and surface 'api'", async () => {
    await app.fetch(post(PATH, { keyPublicId: "aky-old" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("rotate_api_key");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes keyPublicId and optional name to invoke", async () => {
    await app.fetch(
      post(PATH, { keyPublicId: "aky-123", name: "New Key Name" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.keyPublicId).toBe("aky-123");
    expect(body.name).toBe("New Key Name");
  });

  it("missing keyPublicId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── research.swarm.start ──────────────────────────────────────────────────────
