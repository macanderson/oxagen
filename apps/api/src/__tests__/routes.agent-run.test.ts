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
  readAttemptEventsSince: vi.fn(),
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

vi.mock("@oxagen/agent-runner", async () => {
  // `buildLegacyRunSpecV1` is the SHARED spec builder, not an incidental
  // helper — mocking it away would let this suite pass while the route and the
  // worker's parser disagreed about the enqueued shape, which is exactly the
  // drift centralizing it was meant to end. Import the real one.
  // Imported from the leaf module, not the barrel: the barrel pulls in
  // run-store.ts and therefore @oxagen/database, which this suite has no
  // business loading.
  const actual = await vi.importActual<
    typeof import("@oxagen/agent-runner/run-spec-v1-legacy")
  >("@oxagen/agent-runner/run-spec-v1-legacy");
  return {
    buildLegacyRunSpecV1: actual.buildLegacyRunSpecV1,
    // Read at module scope by @oxagen/inngest-functions' lease sweeper, which
    // app.ts pulls in transitively. Mocking the package away leaves that
    // top-level read undefined and the whole suite fails to COLLECT — nothing
    // to do with these routes. Kept as a literal because the real constant
    // lives in run-store.ts, whose import would drag @oxagen/database into a
    // route unit test; nothing here exercises the retry cap, so the value only
    // has to exist.
    MAX_RUN_ATTEMPTS: 3,
    createPostgresRunStore: () => ({
      enqueueRun: mocks.enqueueRun,
      claimNextRun: vi.fn(),
      renewLease: vi.fn(),
      appendEvents: vi.fn(),
      readEventsSince: mocks.readEventsSince,
      readAttemptEventsSince: mocks.readAttemptEventsSince,
      saveCheckpoint: vi.fn(),
      completeRun: vi.fn(),
      failRun: vi.fn(),
      cancelRun: vi.fn(),
      requestCancel: mocks.requestCancel,
      isCancelRequested: vi.fn(),
      getRunByPublicId: mocks.getRunByPublicId,
    }),
  };
});

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
    specVersion: 1,
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
  delete process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED;
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

// ── OXAGEN_V1_RUN_ADMISSION_ENABLED — method-level admission gate ─────────────
//
// The property under test is a SEPARATION, not a switch: closing legacy v1
// admission must stop new writes and nothing else. If a future refactor folds
// this gate into the router-level OXAGEN_DURABLE_RUNS check, the "reads still
// work" cases below are what fail.

describe("durable-run API: legacy v1 admission gate", () => {
  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
    mocks.enqueueRun.mockResolvedValue({
      runId: "run-uuid-1",
      publicId: "arun_abc123",
    });
    mocks.getRunByPublicId.mockResolvedValue(summary());
    setRunSseTimingForTests({ pollIntervalMs: 2, heartbeatIntervalMs: 60_000 });
  });

  it("admits by DEFAULT when the var is unset — PR 1A must not close the queue", async () => {
    const res = await app.fetch(post("/runs", { instruction: "hi" }));
    expect(res.status).toBe(202);
    expect(mocks.enqueueRun).toHaveBeenCalledTimes(1);
  });

  it.each(["1", "true"])("admits when the var is %o", async (value) => {
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = value;
    const res = await app.fetch(post("/runs", { instruction: "hi" }));
    expect(res.status).toBe(202);
  });

  it.each(["0", "false"])(
    "REFUSES admission with 403 when the var is %o",
    async (value) => {
      process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = value;
      const res = await app.fetch(post("/runs", { instruction: "hi" }));
      // 403, not 404: the router is mounted and every other method on this
      // path still works, so reporting the resource as absent would be a lie.
      expect(res.status).toBe(403);
      expect(mocks.enqueueRun).not.toHaveBeenCalled();
    },
  );

  it("refuses BEFORE parsing the body — a closed gate is not a validation error", async () => {
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = "0";
    const res = await app.fetch(post("/runs", { nonsense: true }));
    expect(res.status).toBe(403);
  });

  it("keeps GET /runs/:publicId serving historical rows while admission is off", async () => {
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = "0";
    const res = await app.fetch(get("/runs/arun_abc123"));
    expect(res.status).toBe(200);
    expect(mocks.getRunByPublicId).toHaveBeenCalled();
  });

  it("keeps the SSE subscription serving historical events while admission is off", async () => {
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = "0";
    mocks.getRunByPublicId.mockResolvedValue(summary({ status: "completed" }));
    mocks.readEventsSince.mockImplementation(
      async (_runId: string, afterSeq: number) =>
        [
          {
            seq: 1,
            type: "text-delta",
            payload: { text: "a" },
            createdAt: new Date(),
          },
        ].filter((e) => e.seq > afterSeq),
    );
    const res = await app.fetch(get("/runs/arun_abc123/events"));
    expect(res.status).toBe(200);
    const records = parseSse(await res.text());
    expect(records.some((r) => r.event === "text-delta")).toBe(true);
    expect(records.some((r) => r.event === "done")).toBe(true);
  });

  it("keeps cancel working while admission is off (queued work still drains)", async () => {
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = "0";
    const res = await app.fetch(post("/runs/arun_abc123/cancel"));
    expect(res.status).toBe(202);
    expect(mocks.requestCancel).toHaveBeenCalledWith("run-uuid-1");
  });

  it("still 404s everything when the ROUTER gate is off, whatever admission says", async () => {
    delete process.env.OXAGEN_DURABLE_RUNS;
    process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED = "1";
    expect((await app.fetch(get("/runs/arun_abc123"))).status).toBe(404);
    expect((await app.fetch(post("/runs", { instruction: "hi" }))).status).toBe(
      404,
    );
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
    let readCall = 0;
    mocks.readEventsSince.mockImplementation(
      async (_runId: string, afterSeq: number) => {
        readCall += 1;
        if (readCall < 3) return [];
        // The `afterSeq` filter is NOT decoration. `drainSince` loops until a
        // read comes back empty (a page-capped read only sees the whole
        // backlog when it fits in one page), so a mock that re-served the same
        // row on every call — as the real query never would, its WHERE clause
        // being `seq > afterSeq` — would spin forever and exhaust the heap.
        // A `mockResolvedValueOnce` chain terminates too, but by exhausting a
        // fixed script rather than by modelling the query, so it would go on
        // passing if the route stopped advancing its cursor.
        return [
          {
            seq: 1,
            type: "final-diff",
            payload: { diff: "final" },
            createdAt: new Date(),
          },
        ].filter((e) => e.seq > afterSeq);
      },
    );

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

  // ── Cursor grammar, shared by both record versions ───────────────────────

  it.each(["-1", "abc", "1.5", "1e3", ""])(
    "400s on a malformed `after` cursor %o",
    async (after) => {
      mocks.getRunByPublicId.mockResolvedValue(summary());
      const res = await app.fetch(
        get(`/runs/arun_abc123/events?after=${after}`),
      );
      expect(res.status).toBe(400);
    },
  );

  it.each([
    ["20 digits", "99999999999999999999"],
    // 19 digits but still past the signed-bigint max — a digit-count bound
    // would let this through to `::bigint` and turn a bad request into a 500.
    ["19 digits past the bigint max", "9999999999999999999"],
  ])(
    "400s on an `after` cursor out of bigint range (%s)",
    async (_l, after) => {
      mocks.getRunByPublicId.mockResolvedValue(summary());
      const res = await app.fetch(
        get(`/runs/arun_abc123/events?after=${after}`),
      );
      expect(res.status).toBe(400);
    },
  );

  it("accepts the exact signed-bigint maximum", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ specVersion: 2, status: "completed" }),
    );
    mocks.readAttemptEventsSince.mockResolvedValue([]);
    const res = await app.fetch(
      get("/runs/arun_abc123/events?after=9223372036854775807"),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.readAttemptEventsSince).toHaveBeenCalledWith(
      "run-uuid-1",
      "9223372036854775807",
    );
  });
});

// ── V2 SSE — fenced attempts, cursored on the DECIMAL run_seq ─────────────────
//
// The two record versions are read by different store methods with different
// cursors, and the route picks between them from the run's own `specVersion`.
// Getting this wrong is silent: a v2 run read through the v1 reader returns
// nothing (every v2 event row has `seq IS NULL`) and looks like an idle run.

describe("durable-run API: GET /runs/:publicId/events — V2 runs", () => {
  function v2Event(runSeq: string, attemptSeq: number, eventType: string) {
    return {
      eventId: `evt-uuid-${attemptSeq}`,
      attemptId: `attempt-uuid-${attemptSeq}`,
      attemptPublicId: "arat_abc123",
      runSeq,
      attemptSeq,
      eventSchemaVersion: "1",
      eventType,
      stage: "model",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      eventDigest: `sha256:${"b".repeat(64)}`,
      payload: { tokens: 12 },
      encryptedPayloadRef: null,
      observedAt: new Date("2026-07-18T00:00:03.000Z"),
      recordedAt: new Date("2026-07-18T00:00:04.000Z"),
    };
  }

  beforeEach(() => {
    process.env.OXAGEN_DURABLE_RUNS = "1";
    setRunSseTimingForTests({ pollIntervalMs: 2, heartbeatIntervalMs: 60_000 });
  });

  it("reads the V2 log, ids on the decimal run_seq, and never touches the V1 reader", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ specVersion: 2, status: "completed" }),
    );
    mocks.readAttemptEventsSince.mockImplementation(
      async (_runId: string, afterRunSeq: string) =>
        [
          v2Event("1", 1, "model.call_completed"),
          v2Event("2", 2, "tool.call_completed"),
        ].filter((e) => BigInt(e.runSeq) > BigInt(afterRunSeq)),
    );

    const res = await app.fetch(get("/runs/arun_abc123/events"));
    expect(res.status).toBe(200);
    const records = parseSse(await res.text());

    expect(mocks.readEventsSince).not.toHaveBeenCalled();
    expect(mocks.readAttemptEventsSince).toHaveBeenCalledWith(
      "run-uuid-1",
      "0",
    );

    const emitted = records.filter((r) => r.event?.includes("."));
    expect(emitted.map((r) => r.id)).toEqual(["1", "2"]);
    expect(emitted[0]!.event).toBe("model.call_completed");
    expect(records.some((r) => r.event === "done")).toBe(true);
  });

  it("resumes from a bigint cursor without going through a JS number", async () => {
    // 2^53 + 1 — the first integer a double cannot represent. Routing the
    // cursor through Number() would resume this subscriber one event early,
    // forever.
    const beyondDouble = "9007199254740993";
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ specVersion: 2, status: "completed" }),
    );
    mocks.readAttemptEventsSince.mockResolvedValue([]);

    const res = await app.fetch(
      get(`/runs/arun_abc123/events?after=${beyondDouble}`),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.readAttemptEventsSince).toHaveBeenCalledWith(
      "run-uuid-1",
      beyondDouble,
    );
  });

  it("emits the verifiable receipt and NEVER an internal uuid", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ specVersion: 2, status: "completed" }),
    );
    mocks.readAttemptEventsSince.mockImplementation(
      async (_runId: string, afterRunSeq: string) =>
        [v2Event("7", 1, "tool.call_completed")].filter(
          (e) => BigInt(e.runSeq) > BigInt(afterRunSeq),
        ),
    );

    const text = await (
      await app.fetch(get("/runs/arun_abc123/events"))
    ).text();
    const frame = parseSse(text).find((r) => r.id === "7");
    expect(frame!.data).toMatchObject({
      attemptId: "arat_abc123",
      attemptSeq: 1,
      runSeq: "7",
      stage: "model",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      eventDigest: `sha256:${"b".repeat(64)}`,
      payload: { tokens: 12 },
      encryptedPayloadRef: null,
    });
    // Internal uuids stay internal — the attempt is cited by its arat_ id.
    expect(text).not.toContain("attempt-uuid-1");
    expect(text).not.toContain("evt-uuid-1");
  });

  it("uses the V1 reader for a V1 run even when the V2 reader is available", async () => {
    mocks.getRunByPublicId.mockResolvedValue(
      summary({ specVersion: 1, status: "completed" }),
    );
    mocks.readEventsSince.mockResolvedValue([]);
    await (await app.fetch(get("/runs/arun_abc123/events"))).text();
    expect(mocks.readEventsSince).toHaveBeenCalled();
    expect(mocks.readAttemptEventsSince).not.toHaveBeenCalled();
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
