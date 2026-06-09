/**
 * Unit tests for src/routes/v1/connection.ts
 *
 * Covers:
 * - GET /connections — list, status filter forwarded, unknown status → 400
 * - POST /connections — create with valid body → 201, missing required field → 400
 * - GET /connections/:id — get details, empty id → 400
 * - DELETE /connections/:id — delete full (default), delete connection_only mode
 * - GET /connections/:id/preview — forwarded to invoke
 * - POST /connections/:id/suggest-mappings — body merged with path id
 * - GET /connections/:id/mappings — get mappings
 * - PUT /connections/:id/mappings — set mappings, empty mappings → 400
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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws/connections";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

// ── helpers ───────────────────────────────────────────────────────────────────

function get(path: string) {
  return app.fetch(
    makeRequest(path, { headers: { authorization: bearerHeader("oxk_key") } }),
  );
}

function post(path: string, body: unknown) {
  return app.fetch(
    makeRequest(path, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function del(path: string) {
  return app.fetch(
    makeRequest(path, { method: "DELETE", headers: { authorization: bearerHeader("oxk_key") } }),
  );
}

function put(path: string, body: unknown) {
  return app.fetch(
    makeRequest(path, {
      method: "PUT",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

// ── GET /connections ──────────────────────────────────────────────────────────

describe("GET /connections", () => {
  it("calls invoke with no filters when no query params", async () => {
    mocks.invoke.mockResolvedValue({ connections: [] });
    const res = await get(BASE);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.status).toBeUndefined();
    expect(input.connectorId).toBeUndefined();
  });

  it("forwards status filter to invoke", async () => {
    mocks.invoke.mockResolvedValue({ connections: [] });
    const res = await get(`${BASE}?status=active`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.status).toBe("active");
  });

  it("forwards connectorId filter to invoke", async () => {
    mocks.invoke.mockResolvedValue({ connections: [] });
    const res = await get(`${BASE}?connectorId=github`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectorId).toBe("github");
  });

  it("returns 400 for unknown status value", async () => {
    const res = await get(`${BASE}?status=nonexistent`);
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── POST /connections ─────────────────────────────────────────────────────────

describe("POST /connections", () => {
  const validBody = {
    connectorId: "github",
    displayName: "My GitHub",
    authCredential: { token: "ghs_xxx" },
  };

  it("creates connection and returns 201", async () => {
    mocks.invoke.mockResolvedValue({
      connectionId: "uuid-1",
      publicId: "con_ABC",
      status: "pending_setup",
      connectorId: "github",
      displayName: "My GitHub",
    });
    const res = await post(BASE, validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { publicId: string };
    expect(body.publicId).toBe("con_ABC");
  });

  it("returns 400 when connectorId is missing", async () => {
    const res = await post(BASE, { displayName: "Test", authCredential: {} });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("returns 400 when displayName is empty", async () => {
    const res = await post(BASE, { connectorId: "github", displayName: "", authCredential: {} });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards optional connectionConfig to invoke", async () => {
    mocks.invoke.mockResolvedValue({
      connectionId: "uuid-2",
      publicId: "con_DEF",
      status: "pending_setup",
      connectorId: "github",
      displayName: "My GitHub",
    });
    await post(BASE, { ...validBody, connectionConfig: { org: "acme" } });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionConfig).toEqual({ org: "acme" });
  });
});

// ── GET /connections/:id ──────────────────────────────────────────────────────

describe("GET /connections/:id", () => {
  it("calls invoke with connectionId from path", async () => {
    mocks.invoke.mockResolvedValue({
      id: "uuid-1",
      publicId: "con_ABC",
      connectorId: "github",
      displayName: "My GitHub",
      authScheme: "pat",
      deliveryMethod: "webhook",
      deliveryConfig: null,
      status: "active",
      entityCount: 42,
      lastSyncAt: null,
      errorMessage: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const res = await get(`${BASE}/con_ABC`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
  });
});

// ── DELETE /connections/:id ───────────────────────────────────────────────────

describe("DELETE /connections/:id", () => {
  it("defaults to mode=full when no query param", async () => {
    mocks.invoke.mockResolvedValue({
      deletionJobId: "djob_xyz",
      mode: "full",
      status: "running",
    });
    const res = await del(`${BASE}/con_ABC`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.mode).toBe("full");
  });

  it("forwards connection_only mode", async () => {
    mocks.invoke.mockResolvedValue({
      deletionJobId: "djob_xyz",
      mode: "connection_only",
      status: "running",
    });
    const res = await app.fetch(
      makeRequest(`${BASE}/con_ABC?mode=connection_only`, {
        method: "DELETE",
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.mode).toBe("connection_only");
  });

  it("returns 400 for invalid mode", async () => {
    const res = await app.fetch(
      makeRequest(`${BASE}/con_ABC?mode=nuclear`, {
        method: "DELETE",
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── GET /connections/:id/preview ──────────────────────────────────────────────

describe("GET /connections/:id/preview", () => {
  it("calls invoke with connectionId", async () => {
    mocks.invoke.mockResolvedValue({ recordTypes: [] });
    const res = await get(`${BASE}/con_ABC/preview`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
  });
});

// ── POST /connections/:id/suggest-mappings ────────────────────────────────────

describe("POST /connections/:id/suggest-mappings", () => {
  const suggestBody = {
    recordTypes: [
      {
        sourceRecordType: "pull_request",
        displayName: "Pull Request",
        sampleFields: ["number", "title"],
      },
    ],
  };

  it("merges path connectionId with body", async () => {
    mocks.invoke.mockResolvedValue({ suggestions: [], suggestionIds: [] });
    const res = await post(`${BASE}/con_ABC/suggest-mappings`, suggestBody);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
    expect(Array.isArray(input.recordTypes)).toBe(true);
  });
});

// ── GET /connections/:id/mappings ─────────────────────────────────────────────

describe("GET /connections/:id/mappings", () => {
  it("calls invoke with connectionId from path", async () => {
    mocks.invoke.mockResolvedValue({ mappings: [] });
    const res = await get(`${BASE}/con_ABC/mappings`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
  });
});

// ── PUT /connections/:id/mappings ─────────────────────────────────────────────

describe("PUT /connections/:id/mappings", () => {
  const validMappings = {
    mappings: [{ sourceRecordType: "pull_request", oxagenEntityType: "code_change" }],
  };

  it("saves mappings and returns result", async () => {
    mocks.invoke.mockResolvedValue({
      mappingsCreated: 1,
      mappingsUpdated: 0,
      connectionStatus: "active",
    });
    const res = await put(`${BASE}/con_ABC/mappings`, validMappings);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mappingsCreated: number };
    expect(body.mappingsCreated).toBe(1);
  });

  it("returns 400 when mappings array is empty", async () => {
    const res = await put(`${BASE}/con_ABC/mappings`, { mappings: [] });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("merges path connectionId with body", async () => {
    mocks.invoke.mockResolvedValue({ mappingsCreated: 1, mappingsUpdated: 0, connectionStatus: "active" });
    await put(`${BASE}/con_ABC/mappings`, validMappings);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
  });
});
