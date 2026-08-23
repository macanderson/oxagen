import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  insertEvents: vi.fn(),
  reclaimExpiredAttempts: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // Per-test canned SELECT results, keyed by a marker in the SQL text.
  expiredRuns: [] as unknown[],
  expiredSteps: [] as unknown[],
  expiredAgentRuns: [] as unknown[],
  stuckFanouts: [] as unknown[],
  stuckExecutions: [] as unknown[],
  executedSql: [] as string[],
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

// The V2 attempt reclaimer. Mocked rather than exercised: it opens its own
// per-attempt transactions against Postgres, and the semantics it owns (seal,
// zero-event sentinel, grant + obligation, retry cap) belong to the run store's
// own suite. What this file proves is that the sweeper CALLS it and reports
// what it returns instead of flipping a V2 status column.
vi.mock("@oxagen/agent-runner", () => ({
  MAX_RUN_ATTEMPTS: 3,
  createPostgresRunStore: () => ({
    reclaimExpiredAttempts: mocks.reclaimExpiredAttempts,
  }),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"),
    values,
  });
  // Real drizzle binds an array as ONE parameter via sql.param — mirror it so
  // the ANY(${sql.param(ids)}::uuid[]) call sites work under the mock.
  sql.param = (value: unknown) => ({ param: value });
  return { ...actual, sql };
});

vi.mock("@oxagen/telemetry", () => ({
  insertEvents: mocks.insertEvents,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// Re-implement the executor's pure status helper so this test doesn't pull in
// the executor module's full dependency chain (kernel, tenancy, drizzle ops).
vi.mock("./agent.execute-subagent", () => ({
  deriveFanoutStatus: (completed: number, total: number, anyFailed: boolean) =>
    completed === total
      ? "completed"
      : anyFailed && completed === 0
        ? "failed"
        : "partial",
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sendEvent: ReturnType<typeof vi.fn>;
};

type HandlerFn = (ctx: {
  step: StepCtx;
  event: { data: unknown };
}) => Promise<unknown>;

let sweepHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: HandlerFn) => {
    if (opts.id === "agent.lease-sweep") sweepHandler = handler;
    return [{}];
  },
);

await import("./agent.lease-sweep");

// ── Fake system tx ────────────────────────────────────────────────────────────
function makeFakeTx() {
  return {
    execute: vi.fn().mockImplementation((query: { text: string }) => {
      mocks.executedSql.push(query.text);
      const text = query.text;
      if (
        text.includes("FROM agent.subagent_runs") &&
        text.includes("SELECT")
      ) {
        return Promise.resolve(mocks.expiredRuns);
      }
      if (
        text.includes("FROM agent.agent_execution_steps") &&
        text.includes("SELECT")
      ) {
        return Promise.resolve(mocks.expiredSteps);
      }
      if (text.includes("FROM agent.agent_runs") && text.includes("SELECT")) {
        return Promise.resolve(mocks.expiredAgentRuns);
      }
      if (text.includes("FROM agent.subagent_fanouts f")) {
        return Promise.resolve(mocks.stuckFanouts);
      }
      if (text.includes("FROM agent.agent_executions e")) {
        return Promise.resolve(mocks.stuckExecutions);
      }
      if (
        text.includes("UPDATE agent.subagent_fanouts") ||
        text.includes("UPDATE agent.agent_executions")
      ) {
        return Promise.resolve([{ id: "finalized" }]);
      }
      return Promise.resolve([]);
    }),
  };
}

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: vi.fn().mockResolvedValue(undefined),
  };
}

function expiredRun(id: string, attempts: number) {
  return {
    id,
    org_id: "org-1",
    workspace_id: "ws-1",
    fanout_id: "fan-1",
    attempts,
    claimed_by: "dead-worker",
  };
}

function expiredStep(id: string, attempts: number) {
  return {
    id,
    org_id: "org-1",
    workspace_id: "ws-1",
    execution_id: "exec-1",
    step_number: 0,
    input_payload: { title: "t", goal: "find X", outputFormat: "json" },
    attempts,
    claimed_by: "dead-worker",
  };
}

function expiredAgentRun(
  id: string,
  attempts: number,
  cancelRequested = false,
) {
  return {
    id,
    org_id: "org-1",
    workspace_id: "ws-1",
    attempts,
    claimed_by: "dead-worker",
    cancel_requested: cancelRequested,
  };
}

/** The canonical `digestOfCanonicalJson([])` sentinel a zero-event seal uses. */
const EMPTY_STREAM_DIGEST = `sha256:${"0".repeat(64)}`;

/** One entry as `reclaimExpiredAttempts` returns it. */
function reclaimedAttempt(overrides: {
  runId?: string;
  attemptNumber?: number;
  maxAttempts?: number;
  successorPermitted?: boolean;
  eventCount?: number;
  finalEventDigest?: string | null;
  eventStreamDigest?: string;
  alreadySealed?: boolean;
}) {
  const grantPublicId = "afg_00000000000000000000ff";
  return {
    runId: overrides.runId ?? "run-v2-1",
    attemptNumber: overrides.attemptNumber ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    successorPermitted: overrides.successorPermitted ?? true,
    handle: {
      runId: overrides.runId ?? "run-v2-1",
      attemptId: "attempt-1",
      attemptPublicId: "arat_0000000000000000000001",
      sealId: "seal-1",
      terminalStatus: "abandoned",
      grantId: "grant-1",
      grantPublicId,
      // The grant public id IS the obligation's stable submission id.
      submissionId: grantPublicId,
      obligationId: "obligation-1",
      eventCount: overrides.eventCount ?? 4,
      finalEventDigest:
        overrides.finalEventDigest === undefined
          ? `sha256:${"e".repeat(64)}`
          : overrides.finalEventDigest,
      eventStreamDigest:
        overrides.eventStreamDigest ?? `sha256:${"f".repeat(64)}`,
      alreadySealed: overrides.alreadySealed ?? false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("agentLeaseSweep handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expiredRuns = [];
    mocks.expiredSteps = [];
    mocks.expiredAgentRuns = [];
    mocks.stuckFanouts = [];
    mocks.stuckExecutions = [];
    mocks.executedSql.length = 0;
    mocks.insertEvents.mockResolvedValue(undefined);
    mocks.reclaimExpiredAttempts.mockResolvedValue([]);
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(makeFakeTx()),
    );
  });

  it("no-ops cleanly on an empty sweep", async () => {
    const step = makeStep();
    const result = (await sweepHandler!({
      step,
      event: { data: {} },
    })) as Record<string, number>;

    expect(result).toMatchObject({
      runsRequeued: 0,
      runsFailedAtCap: 0,
      stepsRequeued: 0,
      stepsFailedAtCap: 0,
      agentRunsRequeued: 0,
      agentRunsFailedAtCap: 0,
      agentRunsCancelled: 0,
      fanoutsFinalized: 0,
      executionsFinalized: 0,
    });
    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(mocks.insertEvents).not.toHaveBeenCalled();
  });

  it("requeues expired runs below the cap and fails runs at the cap", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1), expiredRun("r-2", 3)];

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.runsRequeued).toBe(1);
    expect(result.runsFailedAtCap).toBe(1);
    const requeueSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'pending'") && s.includes("subagent_runs"),
    );
    const failSql = mocks.executedSql.find(
      (s) => s.includes("lease expired after") && s.includes("subagent_runs"),
    );
    expect(requeueSql).toBeTruthy();
    expect(failSql).toBeTruthy();
  });

  it("re-emits one dispatch event per distinct fanout with requeued children", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 0), expiredRun("r-2", 1)];

    const step = makeStep();
    await sweepHandler!({ step, event: { data: {} } });

    expect(step.sendEvent).toHaveBeenCalledWith("redispatch-fanouts", [
      {
        name: "agent/subagent.dispatch",
        data: { orgId: "org-1", workspaceId: "ws-1", fanoutId: "fan-1" },
      },
    ]);
  });

  it("re-emits workflow task events for requeued steps with goal/outputFormat from input_payload", async () => {
    mocks.expiredSteps = [expiredStep("s-1", 1)];

    const step = makeStep();
    await sweepHandler!({ step, event: { data: {} } });

    expect(step.sendEvent).toHaveBeenCalledWith("redispatch-steps", [
      {
        name: "agent/workflow.task.execute",
        data: {
          orgId: "org-1",
          workspaceId: "ws-1",
          executionId: "exec-1",
          stepId: "s-1",
          taskIndex: 0,
          goal: "find X",
          outputFormat: "json",
        },
      },
    ]);
  });

  it("backstop-finalizes a stuck fanout and emits the completion event", async () => {
    mocks.stuckFanouts = [
      {
        id: "fan-9",
        org_id: "org-1",
        workspace_id: "ws-1",
        total: 2,
        completed: 1,
        failed: 1,
      },
    ];

    const step = makeStep();
    const result = (await sweepHandler!({
      step,
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.fanoutsFinalized).toBe(1);
    expect(step.sendEvent).toHaveBeenCalledWith("backstop-fanout-completed", [
      expect.objectContaining({
        name: "agent/subagent.fanout.completed",
        data: expect.objectContaining({ fanoutId: "fan-9", status: "partial" }),
      }),
    ]);
  });

  it("backstop-finalizes a quiescent execution", async () => {
    mocks.stuckExecutions = [
      { id: "exec-9", org_id: "org-1", workspace_id: "ws-1", completed: 3 },
    ];

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.executionsFinalized).toBe(1);
  });

  it("emits agent.lease.expired for every expired row and agent.task.reclaimed only for requeued rows", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1), expiredRun("r-2", 3)];

    await sweepHandler!({ step: makeStep(), event: { data: {} } });

    expect(mocks.insertEvents).toHaveBeenCalledTimes(1);
    const rows = mocks.insertEvents.mock.calls[0]![0] as Array<{
      event_type: string;
      payload: string;
    }>;
    const expired = rows.filter((r) => r.event_type === "agent.lease.expired");
    const reclaimed = rows.filter(
      (r) => r.event_type === "agent.task.reclaimed",
    );
    expect(expired).toHaveLength(2);
    expect(reclaimed).toHaveLength(1);
    expect(JSON.parse(reclaimed[0]!.payload)).toMatchObject({
      kind: "subagent_run",
      runId: "r-1",
      fanoutId: "fan-1",
      attempts: 1,
      claimedBy: "dead-worker",
    });
  });

  it("swallows insertEvents failure without failing the sweep", async () => {
    mocks.expiredRuns = [expiredRun("r-1", 1)];
    mocks.insertEvents.mockRejectedValue(new Error("clickhouse down"));

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.runsRequeued).toBe(1);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  // ── agent.agent_runs (agent-engine v2 Phase 2 durable-run worker pool) ──────

  it("requeues expired agent_runs below the cap and fails agent_runs at the cap", async () => {
    mocks.expiredAgentRuns = [
      expiredAgentRun("ar-1", 1),
      expiredAgentRun("ar-2", 3),
    ];

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.agentRunsRequeued).toBe(1);
    expect(result.agentRunsFailedAtCap).toBe(1);
    expect(result.agentRunsCancelled).toBe(0);
    const requeueSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'pending'") && s.includes("agent.agent_runs"),
    );
    const failSql = mocks.executedSql.find(
      (s) =>
        s.includes("lease expired after") && s.includes("agent.agent_runs"),
    );
    expect(requeueSql).toBeTruthy();
    expect(failSql).toBeTruthy();
  });

  // A run can be both lease-expired AND cancel_requested (the caller cancelled
  // while the worker holding it had already died). It must resolve to
  // 'cancelled', never 'pending' — requeuing it would resurrect a run the
  // caller already gave up on.
  it("sweeps a cancel_requested expired agent_run to cancelled instead of requeuing or failing it", async () => {
    mocks.expiredAgentRuns = [expiredAgentRun("ar-3", 1, true)];

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.agentRunsCancelled).toBe(1);
    expect(result.agentRunsRequeued).toBe(0);
    expect(result.agentRunsFailedAtCap).toBe(0);
    const cancelSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'cancelled'") &&
        s.includes("agent.agent_runs"),
    );
    expect(cancelSql).toBeTruthy();
    expect(cancelSql).toContain("error = NULL");
  });

  // A row that revived mid-sweep (a live worker renewed the lease, or a
  // cancel landed between the SELECT snapshot and the write) must not be
  // clobbered — every UPDATE re-guards on the exact predicate that put the
  // row in its bucket.
  it("re-guards every agent_runs UPDATE on status/lease/cancel_requested", async () => {
    mocks.expiredAgentRuns = [
      expiredAgentRun("ar-1", 1),
      expiredAgentRun("ar-2", 3),
      expiredAgentRun("ar-3", 1, true),
    ];

    await sweepHandler!({ step: makeStep(), event: { data: {} } });

    const requeueSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'pending'") && s.includes("agent.agent_runs"),
    )!;
    const failSql = mocks.executedSql.find(
      (s) =>
        s.includes("lease expired after") && s.includes("agent.agent_runs"),
    )!;
    const cancelSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'cancelled'") &&
        s.includes("agent.agent_runs"),
    )!;

    for (const guarded of [requeueSql, failSql]) {
      expect(guarded).toContain("status = 'running'");
      expect(guarded).toContain("lease_expires_at < now()");
      expect(guarded).toContain("cancel_requested = false");
    }
    expect(cancelSql).toContain("status = 'running'");
    expect(cancelSql).toContain("lease_expires_at < now()");
    expect(cancelSql).toContain("cancel_requested = true");
  });

  it("emits agent.lease.expired for every expired agent_run and agent.task.reclaimed only for the requeued one", async () => {
    mocks.expiredAgentRuns = [
      expiredAgentRun("ar-1", 1),
      expiredAgentRun("ar-2", 3),
      expiredAgentRun("ar-3", 1, true),
    ];

    await sweepHandler!({ step: makeStep(), event: { data: {} } });

    expect(mocks.insertEvents).toHaveBeenCalledTimes(1);
    const rows = mocks.insertEvents.mock.calls[0]![0] as Array<{
      event_type: string;
      payload: string;
    }>;
    const agentRunRows = rows.filter(
      (r) => (JSON.parse(r.payload) as { kind: string }).kind === "agent_run",
    );
    const expired = agentRunRows.filter(
      (r) => r.event_type === "agent.lease.expired",
    );
    const reclaimed = agentRunRows.filter(
      (r) => r.event_type === "agent.task.reclaimed",
    );
    expect(expired).toHaveLength(3);
    expect(reclaimed).toHaveLength(1);
    expect(JSON.parse(reclaimed[0]!.payload)).toMatchObject({
      kind: "agent_run",
      runId: "ar-1",
      attempts: 1,
    });
  });

  it("no-ops the agent_runs sweep cleanly when nothing is expired", async () => {
    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.agentRunsRequeued).toBe(0);
    expect(result.agentRunsFailedAtCap).toBe(0);
    expect(result.agentRunsCancelled).toBe(0);
  });

  // The V1 SQL sweep must never touch a V2 row. Flipping one to 'pending'
  // would leave its expired attempt unsealed — no seal means no finalization
  // grant and no obligation — and then let a successor claim on top of
  // evidence nothing is obliged to submit.
  it("scopes every V1 agent_runs read and write to spec_version = 1", async () => {
    mocks.expiredAgentRuns = [
      expiredAgentRun("ar-1", 1),
      expiredAgentRun("ar-2", 3),
      expiredAgentRun("ar-3", 1, true),
    ];

    await sweepHandler!({ step: makeStep(), event: { data: {} } });

    const selectSql = mocks.executedSql.find(
      (s) => s.includes("FROM agent.agent_runs") && s.includes("SELECT"),
    )!;
    const requeueSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'pending'") && s.includes("agent.agent_runs"),
    )!;
    const failSql = mocks.executedSql.find(
      (s) =>
        s.includes("lease expired after") && s.includes("agent.agent_runs"),
    )!;
    const cancelSql = mocks.executedSql.find(
      (s) =>
        s.includes("SET status = 'cancelled'") &&
        s.includes("agent.agent_runs"),
    )!;

    for (const scoped of [selectSql, requeueSql, failSql, cancelSql]) {
      expect(scoped).toContain("spec_version = 1");
    }
  });

  // ── V2 attempt reclaim (docs/specs/run-evidence-ingress/spec.md) ───────────

  it("reclaims expired V2 attempts through reclaimExpiredAttempts, not raw SQL", async () => {
    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(mocks.reclaimExpiredAttempts).toHaveBeenCalledWith({
      reclaimerWorkerId: "inngest:agent.lease-sweep",
      limit: 100,
      reasonCode: "lease_expired",
    });
    expect(result.attemptsReclaimed).toBe(0);
    expect(result.finalizationObligations).toBe(0);
    expect(result.attemptsAlreadySealed).toBe(0);
    // No agent_runs row was status-flipped by this sweep at all — and the one
    // path that ever could is scoped to `spec_version = 1`.
    expect(
      mocks.executedSql.filter((s) => s.includes("UPDATE agent.agent_runs")),
    ).toHaveLength(0);
  });

  // A truly zero-event abandoned attempt seals with event_count = 0, a NULL
  // final-event digest, and the canonical empty stream digest — and no
  // synthesized terminal event. The sweeper reports exactly that, unmassaged.
  it("passes a zero-event abandoned attempt through without inventing a terminal event", async () => {
    mocks.reclaimExpiredAttempts.mockResolvedValue([
      reclaimedAttempt({
        eventCount: 0,
        finalEventDigest: null,
        eventStreamDigest: EMPTY_STREAM_DIGEST,
      }),
    ]);

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.attemptsReclaimed).toBe(1);
    expect(result.finalizationObligations).toBe(1);
    expect(result.attemptsRequeuedForSuccessor).toBe(1);
    expect(result.attemptsFailedAtCap).toBe(0);
    // The obligation's stable submission id is logged so a stranded one is
    // findable without querying the ledger.
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reclaimed: 1,
        newlySealed: 1,
        submissionIds: ["afg_00000000000000000000ff"],
      }),
      expect.stringContaining("finalization obligations"),
    );
  });

  it("counts a retry-cap-exhausted attempt as failed-at-cap, not requeued", async () => {
    mocks.reclaimExpiredAttempts.mockResolvedValue([
      reclaimedAttempt({
        attemptNumber: 3,
        maxAttempts: 3,
        successorPermitted: false,
      }),
    ]);

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.attemptsReclaimed).toBe(1);
    expect(result.attemptsFailedAtCap).toBe(1);
    expect(result.attemptsRequeuedForSuccessor).toBe(0);
    // The attempt still sealed, so its evidence is still finalizable.
    expect(result.finalizationObligations).toBe(1);
  });

  it("splits a mixed batch into requeued-for-successor and failed-at-cap", async () => {
    mocks.reclaimExpiredAttempts.mockResolvedValue([
      reclaimedAttempt({ runId: "run-a", successorPermitted: true }),
      reclaimedAttempt({
        runId: "run-b",
        attemptNumber: 3,
        successorPermitted: false,
      }),
      reclaimedAttempt({ runId: "run-c", successorPermitted: true }),
    ]);

    const result = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(result.attemptsReclaimed).toBe(3);
    expect(result.attemptsRequeuedForSuccessor).toBe(2);
    expect(result.attemptsFailedAtCap).toBe(1);
    expect(result.finalizationObligations).toBe(3);
  });

  // A second sweeper that raced the first gets the SAME handle back — same
  // submission id, no second grant — flagged `alreadySealed`. It must be
  // visible as a duplicate, never counted as new finalization work.
  it("does not double-count a duplicate sweep of an already-sealed attempt", async () => {
    const first = reclaimedAttempt({});
    mocks.reclaimExpiredAttempts.mockResolvedValue([first]);
    const firstResult = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    mocks.reclaimExpiredAttempts.mockResolvedValue([
      reclaimedAttempt({ alreadySealed: true }),
    ]);
    const secondResult = (await sweepHandler!({
      step: makeStep(),
      event: { data: {} },
    })) as Record<string, number>;

    expect(firstResult.finalizationObligations).toBe(1);
    expect(firstResult.attemptsAlreadySealed).toBe(0);

    expect(secondResult.attemptsReclaimed).toBe(1);
    expect(secondResult.attemptsAlreadySealed).toBe(1);
    // No second obligation: the first sweep's grant is the only one.
    expect(secondResult.finalizationObligations).toBe(0);
    expect(secondResult.attemptsRequeuedForSuccessor).toBe(0);
    expect(secondResult.attemptsFailedAtCap).toBe(0);
  });
});
