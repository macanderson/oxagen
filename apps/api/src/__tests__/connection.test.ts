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
  // The /:id/resync route calls withTenantDb + runInTenantScope + eventClient
  // directly (not through invoke), so those layers are mocked here.
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  eventSend: vi.fn(),
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

// Spread the real module so new module-level `schema.<table>` projections in
// transitively imported services never crash this suite at import time; only
// the DB entrypoint is overridden.
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: vi.fn((...args) => ({ and: args })),
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
  };
});

vi.mock("../event-client", () => ({
  eventClient: { send: mocks.eventSend },
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws/connections";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  // runInTenantScope runs its callback directly; resync tests override the rows
  // returned by withTenantDb, and eventClient.send resolves by default.
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mocks.eventSend.mockResolvedValue(undefined);
});

// A chainable drizzle tx stub whose terminal .limit() resolves to `rows`.
function txReturning(rows: unknown[]) {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => rows,
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(builder),
  );
}

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
    makeRequest(path, {
      method: "DELETE",
      headers: { authorization: bearerHeader("oxk_key") },
    }),
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
    // "connected" is a member of the connection.list status enum
    // (pending_setup | connected | paused | error | deleting | deleted).
    // The old "active" value was dropped from the contract, so it now 400s.
    const res = await get(`${BASE}?status=connected`);
    expect(res.status).toBe(200);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.status).toBe("connected");
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
    const res = await post(BASE, {
      connectorId: "github",
      displayName: "",
      authCredential: {},
    });
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
    mappings: [
      { sourceRecordType: "pull_request", oxagenEntityType: "code_change" },
    ],
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
    mocks.invoke.mockResolvedValue({
      mappingsCreated: 1,
      mappingsUpdated: 0,
      connectionStatus: "active",
    });
    await put(`${BASE}/con_ABC/mappings`, validMappings);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.connectionId).toBe("con_ABC");
  });
});

// ── POST /connections/:id/resync ──────────────────────────────────────────────
// This route bypasses invoke() and talks to withTenantDb + eventClient directly.

describe("POST /connections/:id/resync", () => {
  it("queues an initial-sync event when the connection exists", async () => {
    txReturning([
      {
        id: "uuid-1",
        orgId: "test-org",
        workspaceId: "test-ws",
        connectorId: "github",
        status: "connected",
        deliveryConfig: {
          owner: "acme",
          repo: "api",
          defaultBranch: "develop",
        },
      },
    ]);
    const res = await post(`${BASE}/con_ABC/resync`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean };
    expect(body.queued).toBe(true);
    expect(mocks.eventSend).toHaveBeenCalledTimes(1);
    const evt = mocks.eventSend.mock.calls[0]?.[0] as {
      name: string;
      data: Record<string, unknown>;
    };
    expect(evt.name).toBe("ingestion/github.initial-sync");
    expect(evt.data.connectionId).toBe("uuid-1");
    expect(evt.data.owner).toBe("acme");
    expect(evt.data.repo).toBe("api");
    expect(evt.data.defaultBranch).toBe("develop");
  });

  it("returns 404 and sends no event when the connection is missing", async () => {
    txReturning([]);
    const res = await post(`${BASE}/con_MISSING/resync`, {});
    expect(res.status).toBe(404);
    expect(mocks.eventSend).not.toHaveBeenCalled();
  });

  it("falls back to empty owner/repo and main branch when deliveryConfig is null", async () => {
    txReturning([
      {
        id: "uuid-2",
        orgId: "test-org",
        workspaceId: "test-ws",
        connectorId: "github",
        status: "connected",
        deliveryConfig: null,
      },
    ]);
    const res = await post(`${BASE}/con_ABC/resync`, {});
    expect(res.status).toBe(200);
    const evt = mocks.eventSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(evt.data.owner).toBe("");
    expect(evt.data.repo).toBe("");
    expect(evt.data.defaultBranch).toBe("main");
  });
});

// ── PATCH /connections/:id ────────────────────────────────────────────────────

describe("PATCH /connections/:id", () => {
  it("forwards the rename to connection.update with the path id", async () => {
    mocks.invoke.mockResolvedValue({
      connectionId: "con_ABC",
      displayName: "Renamed",
    });
    const res = await app.fetch(
      makeRequest(`${BASE}/con_ABC`, {
        method: "PATCH",
        headers: {
          authorization: bearerHeader("oxk_key"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ displayName: "Renamed" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const [name, input] = mocks.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("update_connection");
    expect(input.connectionId).toBe("con_ABC");
    expect(input.displayName).toBe("Renamed");
  });
});

// ── POST /connections/:id/pause ───────────────────────────────────────────────

describe("POST /connections/:id/pause", () => {
  it("forwards paused=true to connection.pause with the path id", async () => {
    mocks.invoke.mockResolvedValue({
      connectionId: "con_ABC",
      status: "paused",
    });
    const res = await post(`${BASE}/con_ABC/pause`, { paused: true });
    expect(res.status).toBe(200);
    const [name, input] = mocks.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("pause_connection");
    expect(input.connectionId).toBe("con_ABC");
    expect(input.paused).toBe(true);
  });

  it("forwards paused=false to resume", async () => {
    mocks.invoke.mockResolvedValue({
      connectionId: "con_ABC",
      status: "connected",
    });
    await post(`${BASE}/con_ABC/pause`, { paused: false });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.paused).toBe(false);
  });
});
