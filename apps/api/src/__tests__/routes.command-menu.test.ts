/**
 * Unit tests for the Command Menu route handlers:
 *   command.menu.search, command.menu.suggest
 *
 * Pattern (matches routes.document-form-image.test.ts): mock at the adapter
 * seam (@oxagen/auth, @oxagen/oxagen/kernel, @oxagen/billing, @oxagen/handlers,
 * middleware/logger), assert happy path forwards the invoke result as JSON,
 * invoke is called once with the correct contract name + parsed body + surface
 * "api", and cover route-specific validation edge cases.
 *
 * These routes are the missing API layer for the command.* contracts (both are
 * surfaces: ["api", "agent"]); without them the route–contract parity test
 * fails with "No route found for contract command.menu.suggest".
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
  return {
    ...real,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── command.menu.suggest ─────────────────────────────────────────────────────

describe("command.menu.suggest route", () => {
  const PATH = "/command/menu/suggest";

  it("happy path: invoke called once, returns 200 JSON result", async () => {
    const invokeResult = {
      suggestions: [
        {
          text: "Summarize this run's failure",
          category: "investigate",
          confidence: 0.9,
        },
      ],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { route: "/acme/prod/activity/runs/run_1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'suggest_commands' and surface 'api'", async () => {
    await app.fetch(post(PATH, { route: "/acme/prod/ask" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("suggest_commands");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("forwards parsed context (route + pageEntity.summary) to invoke", async () => {
    await app.fetch(
      post(PATH, {
        route: "/acme/prod/activity/runs/run_42",
        pageEntity: {
          kind: "run",
          id: "run_42",
          summary: "Failed during step 3",
        },
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.route).toBe("/acme/prod/activity/runs/run_42");
    expect(body.pageEntity).toEqual({
      kind: "run",
      id: "run_42",
      summary: "Failed during step 3",
    });
  });

  it("applies schema defaults for optional context fields", async () => {
    await app.fetch(post(PATH, { route: "/acme/prod/ask" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.routeParams).toEqual({});
    expect(body.queryParams).toEqual({});
    expect(body.recentEntities).toEqual([]);
    expect(body.capabilities).toEqual([]);
    expect(body.locale).toBe("en");
  });

  it("missing route → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("route exceeding max length (>2000) → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { route: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── command.menu.search ──────────────────────────────────────────────────────

describe("command.menu.search route", () => {
  const PATH = "/command/menu/search";

  it("happy path: invoke called once, returns 200 JSON result", async () => {
    const invokeResult = {
      rows: [
        {
          kind: "run",
          id: "run_1",
          label: "Run #1",
          scope: "Workspace: Production",
          contextLine: "Succeeded 2m ago",
          href: "/acme/prod/activity/runs/run_1",
        },
      ],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { query: "run", orgSlug: "acme", workspaceSlug: "prod" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'search_command_menu' and surface 'api'", async () => {
    await app.fetch(
      post(PATH, { query: "run", orgSlug: "acme", workspaceSlug: "prod" }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("search_command_menu");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("forwards query, kind filter, and slugs to invoke", async () => {
    await app.fetch(
      post(PATH, {
        query: "alice",
        kind: "principal",
        orgSlug: "acme",
        workspaceSlug: "prod",
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("alice");
    expect(body.kind).toBe("principal");
    expect(body.orgSlug).toBe("acme");
    expect(body.workspaceSlug).toBe("prod");
  });

  it("missing orgSlug → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { query: "run", workspaceSlug: "prod" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing workspaceSlug → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { query: "run", orgSlug: "acme" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid kind enum → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, {
        query: "run",
        kind: "spaceship",
        orgSlug: "acme",
        workspaceSlug: "prod",
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
