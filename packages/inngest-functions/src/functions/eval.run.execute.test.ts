import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi
    .fn()
    .mockImplementation((_scope: unknown, fn: () => unknown) => fn()),
  insertEvalItemResults: vi.fn().mockResolvedValue(undefined),
  providerCostUsdMicros: vi.fn().mockReturnValue(0),
  runTarget: vi.fn(),
  scoreWithJudge: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

// Capture the handler and create-function args, mirroring the pattern used by
// playbook.run.execute.test.ts: mock "../inngest" so the real create-function.ts
// wrapper (step adaptation, NonRetriableError translation) still runs, and the
// captured handler is invoked directly in tests.
type HandlerCtx = {
  event: { data: unknown; name?: string };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent?: (name: string, payload: unknown) => Promise<void>;
    waitForEvent?: (name: string, opts: unknown) => Promise<unknown>;
    sleep?: (name: string, duration: unknown) => Promise<void>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => Promise<unknown>) | null = null;
let capturedFnArgs: unknown[] | null = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    capturedFnArgs = [opts, trigger];
    return {};
  },
);

vi.mock("../inngest", () => ({
  inngest: {
    createFunction: mocks.createFunction,
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertEvalItemResults: mocks.insertEvalItemResults,
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    providerCostUsdMicros: mocks.providerCostUsdMicros,
  };
});

vi.mock("./eval/target", () => ({
  runTarget: mocks.runTarget,
}));

vi.mock("./eval/judge", () => ({
  scoreWithJudge: mocks.scoreWithJudge,
}));

vi.mock("@oxagen/oxagen", () => ({}));

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  },
}));

const { schema, makeWithTenantDbMock } = await import("@oxagen/database");
// Import triggers registration.
await import("./eval.run.execute");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = "org-1";
const WS_ID = "ws-1";
const RUN_ID = "run-uuid-1";
const RUN_PUBLIC_ID = "run-pub-1";
const DATASET_ID = "dataset-uuid-1";

const BASE_EVENT = {
  orgId: ORG_ID,
  workspaceId: WS_ID,
  runId: RUN_ID,
  runPublicId: RUN_PUBLIC_ID,
  datasetId: DATASET_ID,
  maxItems: null as number | null,
};

const MODEL_RUN_ROW = {
  target: {
    kind: "model",
    model: "anthropic/claude-haiku",
    systemPrompt: "Be terse.",
  },
  judgeModel: "anthropic/claude-sonnet",
  passThreshold: "0.7",
  itemCount: 10,
};

const AGENT_RUN_ROW = {
  target: { kind: "agent", agentSlug: "my-agent" },
  judgeModel: "anthropic/claude-sonnet",
  passThreshold: "0.7",
  itemCount: 10,
};

const ITEM_A = {
  publicId: "item-a",
  input: "What is 2+2?",
  expectedOutput: "4",
};
const ITEM_B = {
  publicId: "item-b",
  input: "What is the capital of France?",
  expectedOutput: "Paris",
};

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    waitForEvent: vi.fn().mockResolvedValue(null),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

/** Records every update() call: { table, values }. */
interface UpdateCall {
  table: unknown;
  values: Record<string, unknown>;
}

/**
 * Builds a fake tx that dispatches on the table passed to select().from() /
 * update(), matching eval.run.execute.ts's exact query shapes:
 *  - select({...}).from(evalRuns).where(...).limit(1)               -> run row
 *  - select({...}).from(agents).innerJoin(...).where(...).orderBy(...).limit(1) -> agent row
 *  - select({...}).from(evalDatasetItems).where(...).orderBy(...).limit(n)     -> items
 *  - update(evalRuns).set({...}).where(...)                          -> recorded
 */
function makeTx(opts: {
  runRow?: typeof MODEL_RUN_ROW | typeof AGENT_RUN_ROW | null;
  agentRow?: { config: { instructions?: string } } | null;
  items?: (typeof ITEM_A)[];
  updates: UpdateCall[];
}) {
  const runRow = opts.runRow === undefined ? MODEL_RUN_ROW : opts.runRow;
  const items = opts.items ?? [];
  return {
    select: (_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.evalRuns) {
          return {
            where: () => ({
              limit: () => Promise.resolve(runRow ? [runRow] : []),
            }),
          };
        }
        if (table === schema.evalDatasetItems) {
          return {
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(items),
              }),
            }),
          };
        }
        if (table === schema.agents) {
          return {
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () =>
                    Promise.resolve(opts.agentRow ? [opts.agentRow] : []),
                }),
              }),
            }),
          };
        }
        throw new Error("makeTx: unexpected table passed to select().from()");
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        opts.updates.push({ table, values });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
}

describe("eval.run.execute Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.insertEvalItemResults.mockResolvedValue(undefined);
    mocks.providerCostUsdMicros.mockReturnValue(1000);
  });

  it("registers with id=eval.run.execute, retries=0, and the eval/run.start trigger", () => {
    expect(capturedFnArgs).not.toBeNull();
    const [opts, trigger] = capturedFnArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({ id: "eval.run.execute", retries: 0 });
    expect(trigger).toMatchObject({ event: "eval/run.start" });
  });

  it("returns failed and does not update the run when the run row is not found", async () => {
    const updates: UpdateCall[] = [];
    mocks.withTenantDb.mockImplementation(
      makeWithTenantDbMock(makeTx({ runRow: null, updates })),
    );

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toEqual({ runId: RUN_PUBLIC_ID, status: "failed" });
    expect(updates).toHaveLength(0);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, orgId: ORG_ID }),
      expect.stringContaining("run row not found"),
    );
  });

  it("marks the run running then completed, and rolls up the average score across all items", async () => {
    const updates: UpdateCall[] = [];
    mocks.withTenantDb.mockImplementation(
      makeWithTenantDbMock(
        makeTx({ runRow: MODEL_RUN_ROW, items: [ITEM_A, ITEM_B], updates }),
      ),
    );

    mocks.runTarget
      .mockResolvedValueOnce({
        output: "4",
        modelId: "anthropic/claude-haiku",
        usage: { promptTokens: 10, completionTokens: 2 },
      })
      .mockResolvedValueOnce({
        output: "Paris",
        modelId: "anthropic/claude-haiku",
        usage: { promptTokens: 12, completionTokens: 3 },
      });
    mocks.scoreWithJudge
      .mockResolvedValueOnce({
        score: {
          correctness: 1,
          faithfulness: 1,
          score: 1,
          rationale: "Correct.",
        },
        usage: { promptTokens: 20, completionTokens: 8 },
      })
      .mockResolvedValueOnce({
        score: {
          correctness: 0.5,
          faithfulness: 1,
          score: 0.5,
          rationale: "Partially correct.",
        },
        usage: { promptTokens: 22, completionTokens: 9 },
      });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toEqual({ runId: RUN_PUBLIC_ID, status: "completed" });

    // Two update() calls: mark-running, then mark-completed.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      table: schema.evalRuns,
      values: expect.objectContaining({ status: "running" }),
    });
    expect(updates[1]).toMatchObject({
      table: schema.evalRuns,
      values: expect.objectContaining({
        status: "completed",
        completedCount: 2,
        failedCount: 0,
        avgScore: "0.75",
        scoreBreakdown: {
          correctness: 0.75,
          faithfulness: 1,
          // Item A scores 1 (>= 0.7 threshold, passes); item B scores 0.5
          // (< 0.7 threshold, fails) — so passRate is 1/2.
          passRate: 0.5,
        },
      }),
    });

    // One result row inserted per item.
    expect(mocks.insertEvalItemResults).toHaveBeenCalledTimes(2);
    const rowA = (
      mocks.insertEvalItemResults.mock.calls[0]?.[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(rowA).toMatchObject({
      run_id: RUN_PUBLIC_ID,
      dataset_id: DATASET_ID,
      item_id: "item-a",
      target_kind: "model",
      model: "anthropic/claude-haiku",
      judge_model: "anthropic/claude-sonnet",
      score: 1,
      correctness: 1,
      faithfulness: 1,
      passed: 1,
      status: "completed",
      output: "4",
    });
  });

  it("resolves the agent's instruction prompt and passes it as the target's systemPrompt", async () => {
    const updates: UpdateCall[] = [];
    mocks.withTenantDb.mockImplementation(
      makeWithTenantDbMock(
        makeTx({
          runRow: AGENT_RUN_ROW,
          agentRow: { config: { instructions: "You are my-agent." } },
          items: [ITEM_A],
          updates,
        }),
      ),
    );
    mocks.runTarget.mockResolvedValue({
      output: "4",
      modelId: "balanced/default-model",
      usage: { promptTokens: 5, completionTokens: 1 },
    });
    mocks.scoreWithJudge.mockResolvedValue({
      score: {
        correctness: 1,
        faithfulness: 1,
        score: 1,
        rationale: "Correct.",
      },
      usage: { promptTokens: 5, completionTokens: 1 },
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(mocks.runTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "You are my-agent.",
        modelId: null,
      }),
    );
  });

  it("per-item failure isolation: a failing item writes a failed result row, the run still completes, and the rollup excludes the failure", async () => {
    const updates: UpdateCall[] = [];
    mocks.withTenantDb.mockImplementation(
      makeWithTenantDbMock(
        makeTx({ runRow: MODEL_RUN_ROW, items: [ITEM_A, ITEM_B], updates }),
      ),
    );

    // First item's target call throws; second item succeeds.
    mocks.runTarget
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce({
        output: "Paris",
        modelId: "anthropic/claude-haiku",
        usage: { promptTokens: 12, completionTokens: 3 },
      });
    mocks.scoreWithJudge.mockResolvedValue({
      score: {
        correctness: 1,
        faithfulness: 1,
        score: 1,
        rationale: "Correct.",
      },
      usage: { promptTokens: 22, completionTokens: 9 },
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    // The run completes despite the per-item failure — it does not abort.
    expect(result).toEqual({ runId: RUN_PUBLIC_ID, status: "completed" });

    expect(mocks.insertEvalItemResults).toHaveBeenCalledTimes(2);
    const failedRow = (
      mocks.insertEvalItemResults.mock.calls[0]?.[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(failedRow).toMatchObject({
      item_id: "item-a",
      status: "failed",
      error_class: "Error",
      score: 0,
      correctness: 0,
      faithfulness: 0,
      passed: 0,
      output: "",
      rationale: "model unavailable",
    });

    // Rollup: only the successful item counts toward completedCount/avgScore;
    // the failed item is tallied separately in failedCount and excluded from
    // the average.
    const finalUpdate = updates[updates.length - 1]!;
    expect(finalUpdate.values).toMatchObject({
      status: "completed",
      completedCount: 1,
      failedCount: 1,
      avgScore: "1",
      scoreBreakdown: {
        correctness: 1,
        faithfulness: 1,
        passRate: 1,
      },
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_PUBLIC_ID, itemId: "item-a" }),
      expect.stringContaining("eval item failed"),
    );
  });

  it("records a null avgScore and empty scoreBreakdown means when every item fails", async () => {
    const updates: UpdateCall[] = [];
    mocks.withTenantDb.mockImplementation(
      makeWithTenantDbMock(
        makeTx({ runRow: MODEL_RUN_ROW, items: [ITEM_A], updates }),
      ),
    );
    mocks.runTarget.mockRejectedValue(new Error("boom"));

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });

    expect(result).toEqual({ runId: RUN_PUBLIC_ID, status: "completed" });
    const finalUpdate = updates[updates.length - 1]!;
    expect(finalUpdate.values).toMatchObject({
      completedCount: 0,
      failedCount: 1,
      avgScore: null,
      scoreBreakdown: { correctness: 0, faithfulness: 0, passRate: 0 },
    });
  });

  it("caps the loaded items at min(maxItems, run.itemCount) when maxItems is set", async () => {
    const updates: UpdateCall[] = [];
    let capturedLimit: number | null = null;
    const tx = makeTx({
      runRow: { ...MODEL_RUN_ROW, itemCount: 10 },
      items: [ITEM_A],
      updates,
    });
    const originalFrom = tx.select({}).from;
    // Wrap select().from() to capture the limit() argument for evalDatasetItems.
    tx.select = ((_cols: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.evalDatasetItems) {
          return {
            where: () => ({
              orderBy: () => ({
                limit: (n: number) => {
                  capturedLimit = n;
                  return Promise.resolve([ITEM_A]);
                },
              }),
            }),
          };
        }
        return originalFrom(table);
      },
    })) as typeof tx.select;
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
    mocks.runTarget.mockResolvedValue({
      output: "4",
      modelId: "anthropic/claude-haiku",
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    mocks.scoreWithJudge.mockResolvedValue({
      score: { correctness: 1, faithfulness: 1, score: 1, rationale: "ok" },
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const step = makeStep();
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, maxItems: 3 } },
      step,
    });

    expect(capturedLimit).toBe(3);
  });
});
