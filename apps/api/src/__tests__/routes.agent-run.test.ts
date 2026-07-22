/**
 * Unit tests for the durable-run API (agent-engine v2 Phase 2 integration):
 * POST /runs, GET /runs/:publicId, GET /runs/:publicId/events (resumable
 * SSE), POST /runs/:publicId/cancel.
 *
 * Covers: the OXAGEN_DURABLE_RUNS flag gate (404 when off), the exact
 * RunSpec v1 shape enqueueRun is called with, status read (200/404), SSE
 * replay honoring `after` + terminal `done` emission, and the cancel path.
 * @oxagen/agent-runner's RunStore is mocked (house style — mirrors
 * a2a/bridge.test.ts's `@oxagen/agent-runner` mock); @oxagen/tenancy's
 * runInTenantScope is a passthrough (mirrors chat.stream.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  enqueueRun: vi.fn(),
  getRunByPublicId: vi.fn(),
  readEventsSince: vi.fn(),
  requestCancel: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/agent-runner", () => ({
  createPostgresRunStore: () => ({
    enqueueRun: mocks.enqueueRun,
    claimNextRun: vi.fn(),
    renewLease: vi.fn(),
    appendEvents: vi.fn(),
    readEventsSince: mocks.readEventsSince,
    saveCheckpoint: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    cancelRun: vi.fn(),
    requestCancel: mocks.requestCancel,
    isCancelRequested: vi.fn(),
    getRunByPublicId: mocks.getRunByPublicId,
  }),
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import {
  makeRequest,
  bearerHeader,
  makeApiKeyOk,
  TEST_ORG_ID,
  TEST_WORKSPACE_ID,
} from "./_helpers";
import {
  setRunSseTimingForTests,
  resetRunSseTimingForTests,
} from "../routes/v1/agent.run";
import type { RunSummary } from "@oxagen/agent-runner";

const BASE = "/v1/test-org/test-ws";

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body?: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-uuid-1",
    publicId: "arun_abc123",
    surface: "api-chat",
    status: "pending",
    result: null,
    error: null,
    checkpointSeq: 0,
    attempts: 0,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** Parse `id:`/`event:`/`data:` lines out of an SSE response body into records. */
function parseSse(
  text: string,
): Array<{ id?: string; event?: string; data?: unknown }> {
  const records: Array<{ id?: string; event?: string; data?: unknown }> = [];
  let current: { id?: string; event?: string; data?: unknown } = {};
  for (const line of text.split("\n")) {
    if (line === "") {
      if (Object.keys(current).length > 0) records.push(current);
      current = {};
      continue;
    }
    if (line.startsWith("id:")) current.id = line.slice("id:".length).trim();
    else if (line.startsWith("event:"))
      current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) {
      const raw = line.slice("data:".length).trim();
      try {
        current.data = JSON.parse(raw);
      } catch {
        current.data = raw;
      }
    }
  }
  if (Object.keys(current).length > 0) records.push(current);
  return records;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

afterEach(() => {
  delete process.env.OXAGEN_DURABLE_RUNS;
  resetRunSseTimingForTests();
});

// ── Flag gate ─────────────────────────────────────────────────────────────────

describe("durable-run API: OXAGEN_DURABLE_RUNS flag gate", () => {
  it("POST /runs 404s when the flag is unset", async () => {
    const res = await app.fetch(post("/runs", { instruction: "hi" }));
    expect(res.status).toBe(404);
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it("POST /runs 404s when the flag is explicitly '0'", async () => {
    process.env.OXAGEN_DURABLE_RUNS = "0";
    const res = await app.fetch(post("/runs", { instruction: "hi" }));
    expect(res.status).toBe(404);
  });

  it("GET /runs/:publicId 404s when the flag is off", async () => {
    const res = await app.fetch(get("/runs/arun_abc123"));
    expect(res.status).toBe(404);
    expect(mocks.getRunByPublicId).not.toHaveBeenCalled();
  });

  it("GET /runs/:publicId/events 404s when the flag is off", async () => {
    const res = await app.fetch(get("/runs/arun_abc123/events"));
    expect(res.status).toBe(404);
  });

  it("POST /runs/:publicId/cancel 404s when the flag is off", async () => {
    const res = await app.fetch(post("/runs/arun_abc123/cancel"));
    expect(res.status).toBe(404);
    expect(mocks.requestCancel).not.toHaveBeenCalled();
  });

  it("routes work once the flag is '1'", async () => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
    mocks.getRunByPublicId.mockResolvedValue(summary());
    const res = await app.fetch(get("/runs/arun_abc123"));
    expect(res.status).toBe(200);
  });

  it("routes work once the flag is 'true'", async () => {
    process.env.OXAGEN_DURABLE_RUNS = "true";
    mocks.getRunByPublicId.mockResolvedValue(summary());
    const res = await app.fetch(get("/runs/arun_abc123"));
    expect(res.status).toBe(200);
  });
});

// ── POST /runs — enqueue ──────────────────────────────────────────────────────

describe("durable-run API: POST /runs", () => {
  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
    mocks.enqueueRun.mockResolvedValue({
      runId: "run-uuid-1",
      publicId: "arun_abc123",
    });
  });

  it("202s and enqueues the exact RunSpec v1 shape (instruction + model + toolPolicy)", async () => {
    const res = await app.fetch(
      post("/runs", {
        instruction: "Fix the failing test",
        model: "claude-sonnet",
        toolPolicy: { allowlist: ["read_file", "bash"], riskCeiling: "medium" },
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      runId: "arun_abc123",
      status: "pending",
    });

    expect(mocks.enqueueRun).toHaveBeenCalledTimes(1);
    const input = mocks.enqueueRun.mock.calls[0]![0];
    expect(input).toEqual({
      orgId: TEST_ORG_ID,
      workspaceId: TEST_WORKSPACE_ID,
      surface: "api-chat",
      spec: {
        version: 1,
        instruction: "Fix the failing test",
        model: "claude-sonnet",
        toolPolicy: { allowlist: ["read_file", "bash"], riskCeiling: "medium" },
      },
    });
  });

  it("omits model/toolPolicy keys entirely when not provided (no `history` key either)", async () => {
    await app.fetch(post("/runs", { instruction: "hi" }));
    const spec = mocks.enqueueRun.mock.calls[0]![0].spec;
    expect(Object.keys(spec).sort()).toEqual(["instruction", "version"]);
    expect(spec.version).toBe(1);
  });

  it("400s when instruction is missing", async () => {
    const res = await app.fetch(post("/runs", {}));
    expect(res.status).toBe(400);
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it("400s when instruction is an empty string", async () => {
    const res = await app.fetch(post("/runs", { instruction: "" }));
    expect(res.status).toBe(400);
  });

  it("400s on an unknown top-level field (strict body schema)", async () => {
    const res = await app.fetch(
      post("/runs", { instruction: "hi", extra: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it("400s on an invalid riskCeiling", async () => {
    const res = await app.fetch(
      post("/runs", {
        instruction: "hi",
        toolPolicy: { riskCeiling: "extreme" },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── GET /runs/:publicId — status ──────────────────────────────────────────────

describe("durable-run API: GET /runs/:publicId", () => {
  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
  });

  it("200s with the RunSummary when found", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ status: "running", attempts: 1, checkpointSeq: 3 }),
    );
    const res = await app.fetch(get("/runs/arun_abc123"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.publicId).toBe("arun_abc123");
    expect(body.status).toBe("running");
    expect(body.attempts).toBe(1);
    expect(body.checkpointSeq).toBe(3);
    expect(mocks.getRunByPublicId).toHaveBeenCalledWith("arun_abc123");
  });

  it("404s for an unknown publicId", async () => {
    mocks.getRunByPublicId.mockResolvedValue(null);
    const res = await app.fetch(get("/runs/arun_missing"));
    expect(res.status).toBe(404);
  });
});

// ── GET /runs/:publicId/events — resumable SSE ────────────────────────────────

describe("durable-run API: GET /runs/:publicId/events", () => {
  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
    setRunSseTimingForTests({ pollIntervalMs: 2, heartbeatIntervalMs: 60_000 });
  });

  it("404s for an unknown publicId", async () => {
    mocks.getRunByPublicId.mockResolvedValue(null);
    const res = await app.fetch(get("/runs/arun_missing/events"));
    expect(res.status).toBe(404);
  });

  it("replays only events after `after`, with id=seq and event=type, then emits done for an already-terminal run", async () => {
    mocks.getRunByPublicId.mockResolvedValue(summary({ status: "completed" }));
    const replayEvents = [
      {
        seq: 1,
        type: "text-delta",
        payload: { text: "a" },
        createdAt: new Date(),
      },
      {
        seq: 2,
        type: "text-delta",
        payload: { text: "b" },
        createdAt: new Date(),
      },
      {
        seq: 3,
        type: "final-diff",
        payload: { diff: "x" },
        createdAt: new Date(),
      },
    ];
    mocks.readEventsSince
      .mockImplementationOnce(async (_runId: string, afterSeq: number) => {
        return replayEvents.filter((event) => event.seq > afterSeq);
      })
      .mockResolvedValue([]);

    const res = await app.fetch(get("/runs/arun_abc123/events?after=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    const records = parseSse(text);

    const replayed = records.filter(
      (r) => r.event === "text-delta" || r.event === "final-diff",
    );
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toMatchObject({
      id: "2",
      event: "text-delta",
      data: { text: "b" },
    });
    expect(replayed[1]).toMatchObject({
      id: "3",
      event: "final-diff",
      data: { diff: "x" },
    });
    expect(mocks.readEventsSince).toHaveBeenNthCalledWith(1, "run-uuid-1", 1);
    expect(mocks.readEventsSince).toHaveBeenNthCalledWith(2, "run-uuid-1", 3);

    const done = records.find((r) => r.event === "done");
    expect(done).toBeDefined();
    expect((done!.data as RunSummary).status).toBe("completed");
  });

  it("poll-tails until the run reaches a terminal status, then emits done", async () => {
    const statuses: RunSummary[] = [
      summary({ status: "running" }), // initial existence check
      summary({ status: "running" }), // first poll-loop status read
      summary({ status: "completed" }), // second poll-loop status read — terminal, loop exits
    ];
    let call = 0;
    mocks.getRunByPublicId.mockImplementation(
      async () => statuses[Math.min(call++, statuses.length - 1)],
    );
    mocks.readEventsSince.mockResolvedValue([]);

    const res = await app.fetch(get("/runs/arun_abc123/events"));
    const text = await res.text();
    const records = parseSse(text);

    const done = records.find((r) => r.event === "done");
    expect(done).toBeDefined();
    expect((done!.data as RunSummary).status).toBe("completed");
    // Existence check + at least 2 poll-loop status reads (the terminal
    // observation IS the final summary — no redundant extra fetch after).
    expect(mocks.getRunByPublicId.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("drains an event that commits in the same tick status flips terminal — it appears before done, not lost", async () => {
    // Models the exact race a resumable-SSE surface must close: the worker
    // commits the run's final event AND flips status to terminal in one
    // transaction (plan.md Phase 2). Here that commit becomes visible to
    // readEventsSince strictly AFTER the loop's own readEventsSince call for
    // this tick already ran empty, but BEFORE the drain read that follows the
    // terminal getRunByPublicId observation — so only a drain-after-terminal
    // design (not a naive "read then check status" loop) can see it. A pure
    // afterSeq filter mock would emit this event on any call once `after`
    // clears its seq, which wouldn't distinguish the fixed code from the
    // buggy one — hence the call-counted mock below.
    const statuses: RunSummary[] = [
      summary({ status: "running" }), // initial existence check
      summary({ status: "completed" }), // first poll-loop status read — terminal
    ];
    let statusCall = 0;
    mocks.getRunByPublicId.mockImplementation(
      async () => statuses[Math.min(statusCall++, statuses.length - 1)],
    );

    // Call 1 = initial replay, call 2 = the loop iteration's own read (both
    // still empty — the commit hasn't landed yet); call 3+ = the drain read
    // that runs after the terminal status observation (commit now visible).
    mocks.readEventsSince
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          seq: 1,
          type: "final-diff",
          payload: { diff: "final" },
          createdAt: new Date(),
        },
      ])
      .mockResolvedValue([]);

    const res = await app.fetch(get("/runs/arun_abc123/events"));
    const text = await res.text();
    const records = parseSse(text);

    const finalEvent = records.find((r) => r.id === "1");
    expect(finalEvent).toMatchObject({
      event: "final-diff",
      data: { diff: "final" },
    });

    const doneIndex = records.findIndex((r) => r.event === "done");
    const finalEventIndex = records.findIndex((r) => r.id === "1");
    expect(finalEventIndex).toBeGreaterThanOrEqual(0);
    expect(finalEventIndex).toBeLessThan(doneIndex);
    expect(mocks.readEventsSince).toHaveBeenNthCalledWith(3, "run-uuid-1", 0);
    expect(mocks.readEventsSince).toHaveBeenNthCalledWith(4, "run-uuid-1", 1);
  });
});

// ── POST /runs/:publicId/cancel ────────────────────────────────────────────────

describe("durable-run API: POST /runs/:publicId/cancel", () => {
  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
  });

  it("202s and requests cancellation via the run's internal id", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({
        runId: "run-uuid-42",
        publicId: "arun_abc123",
        status: "running",
      }),
    );
    const res = await app.fetch(post("/runs/arun_abc123/cancel"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "cancelling" });
    expect(mocks.requestCancel).toHaveBeenCalledWith("run-uuid-42");
  });

  it("404s for an unknown publicId and never calls requestCancel", async () => {
    mocks.getRunByPublicId.mockResolvedValue(null);
    const res = await app.fetch(post("/runs/arun_missing/cancel"));
    expect(res.status).toBe(404);
    expect(mocks.requestCancel).not.toHaveBeenCalled();
  });
});
