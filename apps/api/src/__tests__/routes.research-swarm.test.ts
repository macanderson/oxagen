/**
 * Unit tests for the research swarm status route.
 *
 * Regression coverage for the 500-loop bug: when agent.subagent.aggregate
 * throws "Fanout <id> not found" (unknown / cross-tenant swarmId) the route
 * handler must convert it to a 404, NOT let it fall through to the catch-all
 * 500. A 500 caused the client poller to back off and retry indefinitely
 * (60+ consecutive 500s) while the progress bar stayed at "Running 0/3".
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

describe("GET /research/swarm/status", () => {
  const PATH = "/research/swarm/status";
  const SWARM_ID = "0611b0f2-72f8-4eb4-bb92-093f3ccfe6b5";

  it("happy path: forwards invoke result as 200 JSON", async () => {
    const invokeResult = {
      swarmId: SWARM_ID,
      dispatchId: SWARM_ID,
      status: "running",
      completedTasks: 1,
      totalTasks: 3,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(`${PATH}?swarmId=${SWARM_ID}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_research_status");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  // ── Regression: the 500-loop bug ────────────────────────────────────────────
  //
  // agent.subagent.aggregate throws a typed FanoutNotFoundError for an unknown /
  // cross-tenant swarmId. Before the fix, that error was not caught by any
  // specific case in the error middleware, fell through to the catch-all handler,
  // and returned HTTP 500. The client poller then treated the 500 as transient,
  // doubled the retry interval, and kept retrying — producing 60+ consecutive
  // 500s while the research card stayed at "Running 0/3" forever.
  //
  // After the fix the route handler structurally matches the TYPED error (via
  // isFanoutNotFoundError, NOT a brittle message regex), converts it to an
  // HTTPException(404), and the error middleware maps that to HTTP 404.
  it("returns 404 (not 500) when agent.subagent.aggregate throws FanoutNotFoundError", async () => {
    mocks.invoke.mockRejectedValue(new FanoutNotFoundError(SWARM_ID));

    const res = await app.fetch(get(`${PATH}?swarmId=${SWARM_ID}`));
    // Must be 404, not 500. A 500 would have caused the client to retry in a loop.
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error?: { code: string; message: string };
    };
    expect(body.error?.code).toBe("not_found");
  });

  it("returns 404 for a cross-tenant swarmId (typed FanoutNotFoundError)", async () => {
    const crossTenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mocks.invoke.mockRejectedValue(new FanoutNotFoundError(crossTenantId));

    const res = await app.fetch(get(`${PATH}?swarmId=${crossTenantId}`));
    expect(res.status).toBe(404);
  });

  it("still propagates non-not-found errors as 500 (unchanged behaviour)", async () => {
    // A genuine unexpected error must still be a 500, not silently swallowed.
    mocks.invoke.mockRejectedValue(new Error("DB connection lost"));

    const res = await app.fetch(get(`${PATH}?swarmId=${SWARM_ID}`));
    expect(res.status).toBe(500);
  });

  // ── Hardening: the route must NOT over-match on the "not found" string ───────
  //
  // The previous fix matched /not found/i against err.message, which would
  // misclassify ANY error whose message merely contains "not found" — a Postgres
  // "relation ... not found", a kernel unknown-capability error, or a future
  // refactor of the aggregate message — as a 404. The poller would then mark a
  // legitimately-running swarm as failed and stop. Now that the route matches the
  // TYPED error only, an unrelated error whose message contains "not found" must
  // still return 500.
  it("returns 500 (not 404) for an UNRELATED error whose message merely contains 'not found'", async () => {
    mocks.invoke.mockRejectedValue(
      new Error('relation "subagent_fanouts" not found'),
    );

    const res = await app.fetch(get(`${PATH}?swarmId=${SWARM_ID}`));
    // Only the typed not-found error maps to a 404; a plain Error never does,
    // even if its message happens to contain "not found".
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("internal_error");
  });

  it("returns 200 with terminal failed status for an orphaned (timed-out) swarm", async () => {
    // An old swarm that exists in the DB but whose fanout timed out should map
    // to status:"failed" via deriveAggregateStatus → mapStatus. The route must
    // surface this as a 200 with a well-formed payload (never a 500).
    const terminalPayload = {
      swarmId: SWARM_ID,
      dispatchId: SWARM_ID,
      status: "failed",
      completedTasks: 0,
      totalTasks: 3,
    };
    mocks.invoke.mockResolvedValue(terminalPayload);

    const res = await app.fetch(get(`${PATH}?swarmId=${SWARM_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof terminalPayload;
    expect(body.status).toBe("failed");
    expect(body.completedTasks).toBe(0);
  });

  it("missing swarmId query param returns 400 (Zod input validation)", async () => {
    // The Zod schema requires swarmId — omitting it is a client error, not a 500.
    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(400);
  });
});
