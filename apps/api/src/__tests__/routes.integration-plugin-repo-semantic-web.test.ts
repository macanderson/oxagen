/**
 * Unit tests for route handlers:
 *   integration.install, integration.list, integration.get,
 *   integration.configure, integration.sync, integration.metrics, integration.delete,
 *   plugin.schema.get, plugin.schema.validate, plugin.version.list,
 *   repo.configure, repo.sync, repo.pause, repo.resume, repo.metrics,
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

describe("repo.create route", () => {
  const validBody = { org: "acme", name: "backend-service" };

  it("happy path: 201 with new repo details", async () => {
    mocks.invoke.mockResolvedValue({
      fullName: "acme/backend-service",
      htmlUrl: "https://github.com/acme/backend-service",
      defaultBranch: "main",
    });
    const res = await authPost("/repos", validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fullName).toBe("acme/backend-service");
    expect(body.htmlUrl).toBe("https://github.com/acme/backend-service");
    expect(body.defaultBranch).toBe("main");
  });

  it("calls invoke with 'create_repo' and { surface: 'api' }", async () => {
    await authPost("/repos", {
      org: "acme",
      name: "new-repo",
      private: true,
      autoInit: true,
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.org).toBe("acme");
    expect(input.name).toBe("new-repo");
    expect(input.private).toBe(true);
  });

  it("omitting org → 201, creates in the connected user's personal account", async () => {
    // repo.create's `org` is optional by design (omit → personal account); a
    // missing org must NOT 400 — it succeeds and invoke is called with no org.
    mocks.invoke.mockResolvedValue({
      fullName: "octocat/no-org",
      htmlUrl: "https://github.com/octocat/no-org",
      defaultBranch: "main",
    });
    const res = await authPost("/repos", { name: "no-org" });
    expect(res.status).toBe(201);
    expect(mocks.invoke).toHaveBeenCalled();
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.org).toBeUndefined();
    expect(input.name).toBe("no-org");
  });

  it("missing required name → 400, invoke not called", async () => {
    const res = await authPost("/repos", { org: "acme" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── repo.fork ─────────────────────────────────────────────────────────────────

describe("repo.fork route", () => {
  const validBody = { owner: "openai", repo: "openai-node" };

  it("happy path: 201 with fork details", async () => {
    mocks.invoke.mockResolvedValue({
      fullName: "acme/openai-node",
      htmlUrl: "https://github.com/acme/openai-node",
      defaultBranch: "main",
    });
    const res = await authPost("/repos/fork", validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fullName).toBe("acme/openai-node");
  });

  it("calls invoke with 'fork_repo' and { surface: 'api' }", async () => {
    await authPost("/repos/fork", {
      owner: "openai",
      repo: "openai-node",
      intoOrg: "acme",
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("fork_repo");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.owner).toBe("openai");
    expect(input.repo).toBe("openai-node");
    expect(input.intoOrg).toBe("acme");
  });

  it("missing required owner → 400, invoke not called", async () => {
    const res = await authPost("/repos/fork", { repo: "openai-node" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── repo.file.put ─────────────────────────────────────────────────────────────

describe("repo.file.put route", () => {
  const validBody = {
    owner: "acme",
    repo: "backend-service",
    path: "src/hello.ts",
    content: "export const hello = 'world';",
    message: "feat: add hello",
  };

  it("happy path: 200 with commit details", async () => {
    mocks.invoke.mockResolvedValue({
      commitSha: "abc123",
      htmlUrl: "https://github.com/acme/backend-service/blob/main/src/hello.ts",
    });
    const res = await authPut("/repos/file", validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.commitSha).toBe("abc123");
    expect(body.htmlUrl).toContain("github.com");
  });

  it("calls invoke with 'put_repo_file' and { surface: 'api' }", async () => {
    await authPut("/repos/file", { ...validBody, branch: "feature/hello" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("put_repo_file");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.path).toBe("src/hello.ts");
    expect(input.branch).toBe("feature/hello");
  });

  it("missing required content → 400, invoke not called", async () => {
    const res = await authPut("/repos/file", {
      owner: "acme",
      repo: "backend-service",
      path: "src/hello.ts",
      message: "feat: add hello",
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── repo.branch.create ────────────────────────────────────────────────────────

describe("repo.branch.create route", () => {
  const validBody = {
    owner: "acme",
    repo: "backend-service",
    branch: "feature/add-hello",
  };

  it("happy path: 201 with branch ref and sha", async () => {
    mocks.invoke.mockResolvedValue({
      ref: "refs/heads/feature/add-hello",
      sha: "abc123def456",
    });
    const res = await authPost("/repos/branch", validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ref).toBe("refs/heads/feature/add-hello");
    expect(body.sha).toBe("abc123def456");
  });

  it("calls invoke with 'create_branch' and { surface: 'api' }", async () => {
    await authPost("/repos/branch", {
      owner: "acme",
      repo: "backend-service",
      branch: "feature/x",
      fromBranch: "main",
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_branch");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.branch).toBe("feature/x");
    expect(input.fromBranch).toBe("main");
  });

  it("missing required branch → 400, invoke not called", async () => {
    const res = await authPost("/repos/branch", {
      owner: "acme",
      repo: "backend-service",
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── repo.pr.open ──────────────────────────────────────────────────────────────

describe("repo.pr.open route", () => {
  const validBody = {
    owner: "acme",
    repo: "backend-service",
    title: "feat: add hello",
    head: "feature/add-hello",
    base: "main",
  };

  it("happy path: 201 with PR number and URL", async () => {
    mocks.invoke.mockResolvedValue({
      number: 42,
      htmlUrl: "https://github.com/acme/backend-service/pull/42",
    });
    const res = await authPost("/repos/pulls", validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.number).toBe(42);
    expect(body.htmlUrl).toContain("/pull/42");
  });

  it("calls invoke with 'open_pr' and { surface: 'api' }", async () => {
    await authPost("/repos/pulls", {
      ...validBody,
      body: "PR description",
      draft: true,
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("open_pr");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.head).toBe("feature/add-hello");
    expect(input.base).toBe("main");
    expect(input.draft).toBe(true);
  });

  it("missing required title → 400, invoke not called", async () => {
    const res = await authPost("/repos/pulls", {
      owner: "acme",
      repo: "backend-service",
      head: "feature/add-hello",
      base: "main",
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── web.fetch ─────────────────────────────────────────────────────────────────

describe("web.fetch route", () => {
  const PATH = "/web/fetch";
  const validBody = { url: "https://example.com" };

  it("happy path: 200 with page content", async () => {
    mocks.invoke.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      content: "Hello",
      wordCount: 1,
      fetchedAt: "2026-01-01",
      statusCode: 200,
    });
    const res = await authPost(PATH, validBody);
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'fetch_web_page' and { surface: 'api' }", async () => {
    await authPost(PATH, {
      url: "https://example.com",
      extractMarkdown: true,
      timeout: 5000,
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("fetch_web_page");
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
    mocks.invoke.mockResolvedValue({
      results: [],
      totalResults: 0,
      searchId: "srch-1",
    });
    const res = await authPost(PATH, validBody);
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'search_web' and { surface: 'api' }", async () => {
    await authPost(PATH, {
      query: "best practices for typescript",
      maxResults: 3,
      searchDepth: "advanced",
    });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("search_web");
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
