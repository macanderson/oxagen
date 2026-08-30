/**
 * Unit tests for the lineage.query route (query_lineage —
 * the fleet-lineage explorer's data spine).
 *
 * Pattern: mock at the adapter seam (invoke), assert the handler forwards the
 * dispatchId path param + numeric query caps, dispatches with surface "api",
 * forwards the invoke result as JSON, and converts a typed FanoutNotFoundError
 * to a clean 404 (mirroring routes.research-swarm.test.ts's regression
 * coverage for the same not-found pattern).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
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
import { FanoutNotFoundError } from "@oxagen/agent";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";
const DISPATCH_ID = "sfo_0611b0f272f84eb4bb92093f3ccfe6b5";

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "GET",
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

describe("GET /lineage/query/:dispatchId", () => {
  const invokeResult = {
    dispatchId: DISPATCH_ID,
    rootStatus: "completed",
    totalChildren: 2,
    completedChildren: 2,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:05:00.000Z",
    nodes: [
      {
        runId: "sar_1",
        fanoutId: DISPATCH_ID,
        parentRunId: null,
        childFanoutId: null,
        depth: 0,
        capabilityName: "graph.search",
        outcome: "completed",
        attempts: 1,
        principal: { id: "p1", kind: "agent", displayName: "Agent Alpha" },
        delegationCeiling: null,
        model: "claude-sonnet-5",
        provider: "anthropic",
        spend: {
          costUsd: 0.0034,
          inputTokens: 100,
          outputTokens: 50,
          llmCalls: 1,
        },
        delegationViolation: null,
        startedAt: "2026-07-01T00:00:00.000Z",
        completedAt: "2026-07-01T00:00:02.000Z",
        durationMs: 2000,
      },
    ],
    nodeCount: 1,
    truncated: false,
    maxDepthReached: false,
  };

  it("happy path: forwards invoke result as 200 JSON", async () => {
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(`/lineage/query/${DISPATCH_ID}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'query_lineage' and surface 'api'", async () => {
    mocks.invoke.mockResolvedValue(invokeResult);

    await app.fetch(get(`/lineage/query/${DISPATCH_ID}`));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("query_lineage");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("parses dispatchId from the path param and applies contract defaults for maxDepth/maxNodes", async () => {
    mocks.invoke.mockResolvedValue(invokeResult);

    await app.fetch(get(`/lineage/query/${DISPATCH_ID}`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.dispatchId).toBe(DISPATCH_ID);
    expect(body.maxDepth).toBe(5);
    expect(body.maxNodes).toBe(200);
  });

  it("passes maxDepth and maxNodes query params through as numbers", async () => {
    mocks.invoke.mockResolvedValue(invokeResult);

    await app.fetch(
      get(`/lineage/query/${DISPATCH_ID}?maxDepth=3&maxNodes=50`),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.maxDepth).toBe(3);
    expect(body.maxNodes).toBe(50);
  });

  it("maxDepth over 10 → 400, invoke not called", async () => {
    const res = await app.fetch(
      get(`/lineage/query/${DISPATCH_ID}?maxDepth=11`),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("maxNodes over 500 → 400, invoke not called", async () => {
    const res = await app.fetch(
      get(`/lineage/query/${DISPATCH_ID}?maxNodes=501`),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("returns 404 (not 500) when the handler throws FanoutNotFoundError", async () => {
    mocks.invoke.mockRejectedValue(new FanoutNotFoundError(DISPATCH_ID));

    const res = await app.fetch(get(`/lineage/query/${DISPATCH_ID}`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("not_found");
  });

  it("still propagates non-not-found errors as 500 (unchanged behaviour)", async () => {
    mocks.invoke.mockRejectedValue(new Error("ClickHouse connection lost"));

    const res = await app.fetch(get(`/lineage/query/${DISPATCH_ID}`));
    expect(res.status).toBe(500);
  });
});
