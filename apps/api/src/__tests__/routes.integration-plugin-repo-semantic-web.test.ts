/**
 * Unit tests for route handlers:
 *   integration.install, integration.list, integration.get,
 *   integration.configure, integration.sync, integration.metrics, integration.delete,
 *   plugin.schema.get, plugin.schema.validate, plugin.version.list,
 *   repo.configure, repo.sync, repo.pause, repo.resume, repo.metrics,
 *   semantic.edge.infer, semantic.edge.suggest, semantic.edge.approve, semantic.edge.list,
 *   web.fetch, web.search
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
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
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
  return app.fetch(makeRequest(`${BASE}${path}`, { headers: { authorization: bearerHeader("oxk_key") } }));
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authPatch(path: string, body: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "PATCH",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authDelete(path: string): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "DELETE",
    headers: { authorization: bearerHeader("oxk_key") },
  }));
}

// ── integration.install ───────────────────────────────────────────────────────

describe("integration.install route", () => {
  const PATH = "/integrations";

  it("happy path: 202 on install", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-1", status: "queued", pluginId: "github", displayName: "My GitHub" });
    const res = await authPost(PATH, { pluginId: "github", config: { org: "acme" }, displayName: "My GitHub" });
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'integration.install' and { surface: 'api' }", async () => {
    await authPost(PATH, { pluginId: "github", config: { org: "acme" }, displayName: "My GitHub" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.install");
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
    mocks.invoke.mockResolvedValue({ integrations: [], total: 0, hasMore: false });
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integrations: [], total: 0, hasMore: false });
  });

  it("calls invoke with 'integration.list' and { surface: 'api' }", async () => {
    await authGet(`${PATH}?pluginId=github&limit=10&offset=0`);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.list");
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
    mocks.invoke.mockResolvedValue({ id: "int-1", pluginId: "github", displayName: "GH", version: "1.0", status: "active" });
    const res = await authGet("/integrations/int-1");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'integration.get' and integrationId from path", async () => {
    await authGet("/integrations/int-abc");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.get");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-abc");
  });
});

// ── integration.configure ─────────────────────────────────────────────────────

describe("integration.configure route", () => {
  it("happy path: 200 on configure", async () => {
    mocks.invoke.mockResolvedValue({ integrationId: "int-1", displayName: "Updated", syncCadence: "polling", inferenceEnabled: true, updatedAt: "2026-01-01" });
    const res = await authPatch("/integrations/int-1/configure", { displayName: "Updated" });
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'integration.configure' and merges path id", async () => {
    await authPatch("/integrations/int-xyz/configure", { inferenceEnabled: false });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.configure");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-xyz");
    expect(input.inferenceEnabled).toBe(false);
  });
});

// ── integration.sync ──────────────────────────────────────────────────────────

describe("integration.sync route", () => {
  it("happy path: 202 on sync", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-2", status: "queued", integrationId: "int-1", mode: "incremental" });
    const res = await authPost("/integrations/int-1/sync", {});
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'integration.sync' and integrationId from path", async () => {
    await authPost("/integrations/int-2/sync", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.sync");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-2");
  });
});

// ── integration.metrics ───────────────────────────────────────────────────────

describe("integration.metrics route", () => {
  it("happy path: 200 with metrics", async () => {
    mocks.invoke.mockResolvedValue({ integrationId: "int-1", pluginId: "github", displayName: "GH", status: "active", entityCount: 100, entityCountByType: {}, lastSyncAt: null, lastSyncDurationMs: null, lastErrorAt: null, errorMessage: null });
    const res = await authGet("/integrations/int-1/metrics");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'integration.metrics' and integrationId from path", async () => {
    await authGet("/integrations/int-abc/metrics");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.metrics");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-abc");
  });
});

// ── integration.delete ────────────────────────────────────────────────────────

describe("integration.delete route", () => {
  it("happy path: 202 on delete", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-3", status: "queued", integrationId: "int-1", purgeData: false });
    const res = await authDelete("/integrations/int-1");
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'integration.delete' and integrationId from path", async () => {
    await authDelete("/integrations/int-del");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("integration.delete");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.integrationId).toBe("int-del");
  });

  it("passes purgeData=true from query string", async () => {
    await app.fetch(makeRequest(`${BASE}/integrations/int-1?purgeData=true`, {
      method: "DELETE",
      headers: { authorization: bearerHeader("oxk_key") },
    }));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.purgeData).toBe(true);
  });
});

// ── plugin.schema.get ─────────────────────────────────────────────────────────

describe("plugin.schema.get route", () => {
  it("happy path: 200 with schema", async () => {
    mocks.invoke.mockResolvedValue({ pluginId: "github", title: "GitHub", authSchemes: [], configSchema: [] });
    const res = await authGet("/plugin-schema/github");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'plugin.schema.get' and pluginId from path", async () => {
    await authGet("/plugin-schema/google-drive");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("plugin.schema.get");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.pluginId).toBe("google-drive");
  });
});

// ── plugin.schema.validate ────────────────────────────────────────────────────

describe("plugin.schema.validate route", () => {
  it("happy path: 200 with valid=true", async () => {
    mocks.invoke.mockResolvedValue({ valid: true, errors: [] });
    const res = await authPost("/plugin-schema/github/validate", { config: { org: "acme" } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.valid).toBe(true);
  });

  it("calls invoke with 'plugin.schema.validate' and merges path pluginId", async () => {
    await authPost("/plugin-schema/slack/validate", { config: { token: "xoxb-123" } });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("plugin.schema.validate");
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
    mocks.invoke.mockResolvedValue({ pluginId: "github", currentVersion: "2.0.0", versions: [] });
    const res = await authGet("/plugin-versions/github");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'plugin.version.list' and pluginId from path", async () => {
    await authGet("/plugin-versions/slack?limit=5&includeChangelog=true");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("plugin.version.list");
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
    mocks.invoke.mockResolvedValue({ repoId: "repo-1", displayName: "My Repo", recordTypes: [], paths: { include: [], exclude: [] }, labels: { include: [], exclude: [] }, inferenceEnabled: false, syncCadence: "manual", updatedAt: "2026-01-01" });
    const res = await authPatch("/repos/repo-1/configure", { inferenceEnabled: true });
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'repo.configure' and repoId from path", async () => {
    await authPatch("/repos/repo-xyz/configure", { inferenceEnabled: false });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("repo.configure");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-xyz");
    expect(input.inferenceEnabled).toBe(false);
  });
});

// ── repo.sync ─────────────────────────────────────────────────────────────────

describe("repo.sync route", () => {
  it("happy path: 202 on sync", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-4", status: "queued", mode: "incremental", estimatedRecords: 0 });
    const res = await authPost("/repos/repo-1/sync", {});
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'repo.sync' and repoId from path", async () => {
    await authPost("/repos/repo-abc/sync", { mode: "full" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("repo.sync");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-abc");
  });
});

// ── repo.pause ────────────────────────────────────────────────────────────────

describe("repo.pause route", () => {
  it("happy path: 200 on pause", async () => {
    mocks.invoke.mockResolvedValue({ repoId: "repo-1", status: "paused", pausedAt: "2026-01-01" });
    const res = await authPost("/repos/repo-1/pause", {});
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'repo.pause' and repoId from path", async () => {
    await authPost("/repos/repo-pause-me/pause", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("repo.pause");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-pause-me");
  });
});

// ── repo.resume ───────────────────────────────────────────────────────────────

describe("repo.resume route", () => {
  it("happy path: 200 on resume", async () => {
    mocks.invoke.mockResolvedValue({ repoId: "repo-1", status: "active", resumedAt: "2026-01-01", nextSyncAt: null });
    const res = await authPost("/repos/repo-1/resume", {});
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'repo.resume' and repoId from path", async () => {
    await authPost("/repos/repo-resume-me/resume", {});
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("repo.resume");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-resume-me");
  });
});

// ── repo.metrics ──────────────────────────────────────────────────────────────

describe("repo.metrics route", () => {
  it("happy path: 200 with metrics", async () => {
    mocks.invoke.mockResolvedValue({ repoId: "repo-1", displayName: "My Repo", status: "active", entityCount: 200, entityCountByType: {}, lastSyncAt: null, lastSyncDurationMs: null, lastErrorAt: null, errorMessage: null, syncIntervalSeconds: null, estimatedNextSyncAt: null });
    const res = await authGet("/repos/repo-1/metrics");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'repo.metrics' and repoId from path", async () => {
    await authGet("/repos/repo-met/metrics");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("repo.metrics");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.repoId).toBe("repo-met");
  });
});

// ── semantic.edge.infer ───────────────────────────────────────────────────────

describe("semantic.edge.infer route", () => {
  const PATH = "/semantic-edges/infer";
  const validBody = { semanticEdgePrompt: "Find relationships between customer entities" };

  it("happy path: 202 on infer", async () => {
    mocks.invoke.mockResolvedValue({ jobId: "job-5", status: "queued", estimatedNodes: 50, dryRun: false });
    const res = await authPost(PATH, validBody);
    expect(res.status).toBe(202);
  });

  it("calls invoke with 'semantic.edge.infer' and { surface: 'api' }", async () => {
    await authPost(PATH, validBody);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("semantic.edge.infer");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.semanticEdgePrompt).toBe("Find relationships between customer entities");
  });

  it("missing semanticEdgePrompt → 400, invoke not called", async () => {
    const res = await authPost(PATH, { dryRun: true });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── semantic.edge.suggest ─────────────────────────────────────────────────────

describe("semantic.edge.suggest route", () => {
  it("happy path: 200 with suggestions", async () => {
    mocks.invoke.mockResolvedValue({ suggestions: [], total: 0, limit: 50 });
    const res = await authGet("/semantic-edges/suggest");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'semantic.edge.suggest' and { surface: 'api' }", async () => {
    await authGet("/semantic-edges/suggest?confidenceMin=0.7&limit=20");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("semantic.edge.suggest");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.confidenceMin).toBe(0.7);
    expect(input.limit).toBe(20);
  });
});

// ── semantic.edge.approve (decide) ────────────────────────────────────────────

describe("semantic.edge.approve route", () => {
  it("happy path: 200 on approve", async () => {
    mocks.invoke.mockResolvedValue({ edgeId: "edge-1", decision: "approve" });
    const res = await authPost("/semantic-edges/edge-1/decide", { decision: "approve" });
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'semantic.edge.approve' and edgeId from path", async () => {
    await authPost("/semantic-edges/edge-xyz/decide", { decision: "reject" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("semantic.edge.approve");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.edgeId).toBe("edge-xyz");
    expect(input.decision).toBe("reject");
  });

  it("invalid decision value → 400, invoke not called", async () => {
    const res = await authPost("/semantic-edges/edge-1/decide", { decision: "maybe" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── semantic.edge.list ────────────────────────────────────────────────────────

describe("semantic.edge.list route", () => {
  it("happy path: 200 with edges", async () => {
    mocks.invoke.mockResolvedValue({ edges: [], total: 0, limit: 50 });
    const res = await authGet("/semantic-edges");
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'semantic.edge.list' and { surface: 'api' }", async () => {
    await authGet("/semantic-edges?type=customer&sourceId=src-1&limit=25&offset=0");
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("semantic.edge.list");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.type).toBe("customer");
    expect(input.sourceId).toBe("src-1");
    expect(input.limit).toBe(25);
  });
});

// ── web.fetch ─────────────────────────────────────────────────────────────────

describe("web.fetch route", () => {
  const PATH = "/web/fetch";
  const validBody = { url: "https://example.com" };

  it("happy path: 200 with page content", async () => {
    mocks.invoke.mockResolvedValue({ url: "https://example.com", title: "Example", content: "Hello", wordCount: 1, fetchedAt: "2026-01-01", statusCode: 200 });
    const res = await authPost(PATH, validBody);
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'web.fetch' and { surface: 'api' }", async () => {
    await authPost(PATH, { url: "https://example.com", extractMarkdown: true, timeout: 5000 });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("web.fetch");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.url).toBe("https://example.com");
    expect(input.extractMarkdown).toBe(true);
    expect(input.timeout).toBe(5000);
  });

  it("missing url → 400, invoke not called", async () => {
    const res = await authPost(PATH, { extractMarkdown: true });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid url (not a URL) → 400, invoke not called", async () => {
    const res = await authPost(PATH, { url: "not-a-url" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── web.search ────────────────────────────────────────────────────────────────

describe("web.search route", () => {
  const PATH = "/web/search";
  const validBody = { query: "openai api pricing" };

  it("happy path: 200 with results", async () => {
    mocks.invoke.mockResolvedValue({ results: [], totalResults: 0, searchId: "srch-1" });
    const res = await authPost(PATH, validBody);
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'web.search' and { surface: 'api' }", async () => {
    await authPost(PATH, { query: "best practices for typescript", maxResults: 3, searchDepth: "advanced" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("web.search");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.query).toBe("best practices for typescript");
    expect(input.maxResults).toBe(3);
    expect(input.searchDepth).toBe("advanced");
  });

  it("empty query string → 400, invoke not called", async () => {
    const res = await authPost(PATH, { query: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing query → 400, invoke not called", async () => {
    const res = await authPost(PATH, { maxResults: 5 });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
