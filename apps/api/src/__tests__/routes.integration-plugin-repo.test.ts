/**
 * Unit tests for route handlers:
 *   integration.install, integration.list, integration.get,
 *   integration.configure, integration.sync, integration.metrics, integration.delete,
 *   plugin.schema.get, plugin.schema.validate, plugin.version.list,
 *   repo.configure, repo.sync, repo.pause, repo.resume, repo.metrics
 *
 * ADR-043 removed the repo mutation half (create / fork / file.put /
 * branch.create / pr.open) and the web.* capabilities, so only the
 * read/observe repo routes are exercised here.
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

async function authGet(path: string): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      headers: { authorization: bearerHeader("oxk_key") },
    }),
  );
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function authPatch(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "PATCH",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function authDelete(path: string): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "DELETE",
      headers: { authorization: bearerHeader("oxk_key") },
    }),
  );
}

async function authPut(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "PUT",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

// ── integration.install ───────────────────────────────────────────────────────

describe("integration.install route", () => {
  const PATH = "/integrations";

  it("happy path: 202 on install", async () => {
    mocks.invoke.mockResolvedValue({
      jobId: "job-1",
      status: "queued",
      pluginId: "github",
      displayName: "My GitHub",
    });
    const res = await authPost(PATH, {
      pluginId: "github",
      config: { org: "acme" },
      displayName: "My GitHub",
    });
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'install_integration' and { surface: 'api' }", async () => {
    await authPost(PATH, {
      pluginId: "github",
      config: { org: "acme" },
      displayName: "My GitHub",
    });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("install_integration");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("github");
  });

  it("missing pluginId → 400, invoke not called", async () => {
    const res = await authPost(PATH, { config: {}, displayName: "X" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── integration.list ──────────────────────────────────────────────────────────

describe("integration.list route", () => {
  const PATH = "/integrations";

  it("happy path: 200 with results", async () => {
    mocks.invoke.mockResolvedValue({
      integrations: [],
      total: 0,
      hasMore: false,
    });
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      integrations: [],
      total: 0,
      hasMore: false,
    });
  });

  it("calls invoke with 'list_integrations' and { surface: 'api' }", async () => {
    await authGet(`${PATH}?pluginId=github&limit=10&offset=0`);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_integrations");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("github");
    expect(input.limit).toBe(10);
  });

  it("passes status filter to invoke", async () => {
    await authGet(`${PATH}?status=active`);
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.status).toBe("active");
  });
});

// ── integration.get ───────────────────────────────────────────────────────────

describe("integration.get route", () => {
  it("happy path: 200 with integration details", async () => {
    mocks.invoke.mockResolvedValue({
      id: "int-1",
      pluginId: "github",
      displayName: "GH",
      version: "1.0",
      status: "active",
    });
    const res = await authGet("/integrations/int-1");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_integration' and integrationId from path", async () => {
    await authGet("/integrations/int-abc");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_integration");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-abc");
  });
});

// ── integration.configure ─────────────────────────────────────────────────────

describe("integration.configure route", () => {
  it("happy path: 200 on configure", async () => {
    mocks.invoke.mockResolvedValue({
      integrationId: "int-1",
      displayName: "Updated",
      syncCadence: "polling",
      updatedAt: "2026-01-01",
    });
    const res = await authPatch("/integrations/int-1/configure", {
      displayName: "Updated",
    });
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'configure_integration' and merges path id", async () => {
    await authPatch("/integrations/int-xyz/configure", {
      syncCadence: "webhook",
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("configure_integration");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-xyz");
    expect(input.syncCadence).toBe("webhook");
  });
});

// ── integration.sync ──────────────────────────────────────────────────────────

describe("integration.sync route", () => {
  it("happy path: 202 on sync", async () => {
    mocks.invoke.mockResolvedValue({
      jobId: "job-2",
      status: "queued",
      integrationId: "int-1",
      mode: "incremental",
    });
    const res = await authPost("/integrations/int-1/sync", {});
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'sync_integration' and integrationId from path", async () => {
    await authPost("/integrations/int-2/sync", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("sync_integration");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-2");
  });
});

// ── integration.metrics ───────────────────────────────────────────────────────

describe("integration.metrics route", () => {
  it("happy path: 200 with metrics", async () => {
    mocks.invoke.mockResolvedValue({
      integrationId: "int-1",
      pluginId: "github",
      displayName: "GH",
      status: "active",
      entityCount: 100,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
    });
    const res = await authGet("/integrations/int-1/metrics");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_integration_metrics' and integrationId from path", async () => {
    await authGet("/integrations/int-abc/metrics");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_integration_metrics");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-abc");
  });
});

// ── integration.delete ────────────────────────────────────────────────────────

describe("integration.delete route", () => {
  it("happy path: 202 on delete", async () => {
    mocks.invoke.mockResolvedValue({
      jobId: "job-3",
      status: "queued",
      integrationId: "int-1",
      purgeData: false,
    });
    const res = await authDelete("/integrations/int-1");
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'delete_integration' and integrationId from path", async () => {
    await authDelete("/integrations/int-del");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_integration");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-del");
  });

  it("passes purgeData=true from query string", async () => {
    await app.fetch(
      makeRequest(`${BASE}/integrations/int-1?purgeData=true`, {
        method: "DELETE",
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.purgeData).toBe(true);
  });
});

// ── plugin.schema.get ─────────────────────────────────────────────────────────

describe("plugin.schema.get route", () => {
  it("happy path: 200 with schema", async () => {
    mocks.invoke.mockResolvedValue({
      pluginId: "github",
      title: "GitHub",
      authSchemes: [],
      configSchema: [],
    });
    const res = await authGet("/plugin-schema/github");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_plugin_schema' and pluginId from path", async () => {
    await authGet("/plugin-schema/google-drive");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_plugin_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("google-drive");
  });
});

// ── plugin.schema.validate ────────────────────────────────────────────────────

describe("plugin.schema.validate route", () => {
  it("happy path: 200 with valid=true", async () => {
    mocks.invoke.mockResolvedValue({ valid: true, errors: [] });
    const res = await authPost("/plugin-schema/github/validate", {
      config: { org: "acme" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.valid).toBe(true);
  });

  it("calls invoke with 'validate_plugin_schema' and merges path pluginId", async () => {
    await authPost("/plugin-schema/slack/validate", {
      config: { token: "xoxb-123" },
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("validate_plugin_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("slack");
    expect(input.config).toEqual({ token: "xoxb-123" });
  });

  it("missing config → 400, invoke not called", async () => {
    const res = await authPost("/plugin-schema/github/validate", {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── plugin.version.list ───────────────────────────────────────────────────────

describe("plugin.version.list route", () => {
  it("happy path: 200 with versions", async () => {
    mocks.invoke.mockResolvedValue({
      pluginId: "github",
      currentVersion: "2.0.0",
      versions: [],
    });
    const res = await authGet("/plugin-versions/github");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'list_plugin_versions' and pluginId from path", async () => {
    await authGet("/plugin-versions/slack?limit=5&includeChangelog=true");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_plugin_versions");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("slack");
    expect(input.limit).toBe(5);
    expect(input.includeChangelog).toBe(true);
  });
});

// ── repo.configure ────────────────────────────────────────────────────────────

describe("repo.configure route", () => {
  it("happy path: 200 on configure", async () => {
    mocks.invoke.mockResolvedValue({
      repoId: "repo-1",
      displayName: "My Repo",
      recordTypes: [],
      paths: { include: [], exclude: [] },
      labels: { include: [], exclude: [] },
      syncCadence: "manual",
      updatedAt: "2026-01-01",
    });
    const res = await authPatch("/repos/repo-1/configure", {
      syncCadence: "manual",
    });
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'configure_repo' and repoId from path", async () => {
    await authPatch("/repos/repo-xyz/configure", { syncCadence: "webhook" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("configure_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-xyz");
    expect(input.syncCadence).toBe("webhook");
  });
});

// ── repo.sync ─────────────────────────────────────────────────────────────────

describe("repo.sync route", () => {
  it("happy path: 202 on sync", async () => {
    mocks.invoke.mockResolvedValue({
      jobId: "job-4",
      status: "queued",
      mode: "incremental",
      estimatedRecords: 0,
    });
    const res = await authPost("/repos/repo-1/sync", {});
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'sync_repo' and repoId from path", async () => {
    await authPost("/repos/repo-abc/sync", { mode: "full" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("sync_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-abc");
  });
});

// ── repo.pause ────────────────────────────────────────────────────────────────

describe("repo.pause route", () => {
  it("happy path: 200 on pause", async () => {
    mocks.invoke.mockResolvedValue({
      repoId: "repo-1",
      status: "paused",
      pausedAt: "2026-01-01",
    });
    const res = await authPost("/repos/repo-1/pause", {});
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'pause_repo' and repoId from path", async () => {
    await authPost("/repos/repo-pause-me/pause", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("pause_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-pause-me");
  });
});

// ── repo.resume ───────────────────────────────────────────────────────────────

describe("repo.resume route", () => {
  it("happy path: 200 on resume", async () => {
    mocks.invoke.mockResolvedValue({
      repoId: "repo-1",
      status: "active",
      resumedAt: "2026-01-01",
      nextSyncAt: null,
    });
    const res = await authPost("/repos/repo-1/resume", {});
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'resume_repo' and repoId from path", async () => {
    await authPost("/repos/repo-resume-me/resume", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("resume_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-resume-me");
  });
});

// ── repo.metrics ──────────────────────────────────────────────────────────────

describe("repo.metrics route", () => {
  it("happy path: 200 with metrics", async () => {
    mocks.invoke.mockResolvedValue({
      repoId: "repo-1",
      displayName: "My Repo",
      status: "active",
      entityCount: 200,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
      syncIntervalSeconds: null,
      estimatedNextSyncAt: null,
    });
    const res = await authGet("/repos/repo-1/metrics");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_repo_metrics' and repoId from path", async () => {
    await authGet("/repos/repo-met/metrics");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_repo_metrics");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-met");
  });
});

// ── repo.create ───────────────────────────────────────────────────────────────
