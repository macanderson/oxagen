import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi
    .fn()
    .mockImplementation((_scope: unknown, fn: () => unknown) => fn()),
  insertEvents: vi.fn().mockResolvedValue(undefined),
  insertToolInvocation: vi.fn().mockResolvedValue(undefined),
  kernelInvoke: vi.fn(),
  generateObjectFor: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue(undefined),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  getCapability: vi.fn(),
}));

// Capture the handler and create-function args
type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
    sendEvent?: (name: string, payload: unknown) => Promise<void>;
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
  inngest: { createFunction: mocks.createFunction, send: mocks.inngestSend },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mocks.withSystemDb,
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
    insertEvents: mocks.insertEvents,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.kernelInvoke,
}));

vi.mock("@oxagen/oxagen/registry", () => ({
  getCapability: mocks.getCapability,
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
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

// Import triggers registration
await import("./playbook.run.execute");

// ── Fixture helpers ────────────────────────────────────────────────────────────

const BASE_RUN_ID = "run-uuid-1";
const ORG_ID = "org-1";
const WS_ID = "ws-1";
const VERSION_ID = "ver-uuid-1";

const BASE_EVENT = {
  runId: BASE_RUN_ID,
  orgId: ORG_ID,
  workspaceId: WS_ID,
};

const PENDING_RUN = {
  id: BASE_RUN_ID,
  orgId: ORG_ID,
  workspaceId: WS_ID,
  playbookId: "plb-uuid-1",
  playbookVersionId: VERSION_ID,
  status: "pending",
  input: { git_branch: "main", count: 5 },
  inngestRunId: null,
  startedByUserId: "user-1",
};

function makeStep(
  overrides: Partial<HandlerCtx["step"]> = {},
): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    ...overrides,
  };
}

/**
 * A step.run mock that reproduces Inngest's real memoization behavior: once
 * a given step id has completed, subsequent calls with that same id return
 * the cached result WITHOUT invoking the callback again. Reusing the same
 * instance across two `capturedHandler(...)` invocations simulates Inngest
 * replaying the whole function body from the top — e.g. after a retry, or a
 * worker restart before the function's return value is acknowledged — which
 * is exactly the scenario that used to double-insert ClickHouse telemetry
 * rows emitted outside step.run (or wrapped with a non-deterministic id).
 */
function makeMemoizingStep(): HandlerCtx["step"] {
  const memo = new Map<string, unknown>();
  return {
    run: vi.fn(async (name: string, fn: () => unknown) => {
      if (memo.has(name)) return memo.get(name);
      const result = await fn();
      memo.set(name, result);
      return result;
    }),
  };
}

/** Build a withSystemDb mock that sequences: (1) run, (2) steps, (3) edges */
function buildSystemDbForExecution(opts: {
  run?: typeof PENDING_RUN | null;
  steps?: object[];
  edges?: object[];
}): void {
  let systemCallCount = 0;
  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    systemCallCount++;
    const call = systemCallCount;
    if (call === 1) {
      // load-run
      return fn({
        query: {
          playbookRuns: {
            findFirst: vi.fn().mockResolvedValue(opts.run ?? null),
          },
        },
      });
    }
    if (call === 2) {
      // load steps
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve(opts.steps ?? []),
            }),
          }),
        }),
      });
    }
    if (call === 3) {
      // load edges
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve(opts.edges ?? []),
            }),
          }),
        }),
      });
    }
    return fn({});
  });
}

/** Build a withTenantDb mock that handles all write operations */
function buildTenantDb(
  opts: { stepRunId?: string; approvalId?: string } = {},
): void {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    return fn({
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(undefined),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => ({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: opts.stepRunId ?? "step-run-uuid-1" }]),
        }),
      }),
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("playbook-run-execute Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.insertEvents.mockResolvedValue(undefined);
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.getCapability.mockReturnValue(null); // default: no requiresApproval
  });

  // ── Registration ────────────────────────────────────────────────────────────

  it("registers with id=playbook-run-execute and event trigger", () => {
    expect(capturedFnArgs).not.toBeNull();
    const [opts, trigger] = capturedFnArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "playbook-run-execute",
      retries: 2,
    });
    expect(trigger).toMatchObject({ event: "playbook/run.execute" });
  });

  // ── Run not found ────────────────────────────────────────────────────────────

  it("throws NonRetriableError (name=NonRetriableError) when run is not found", async () => {
    buildSystemDbForExecution({ run: null });
    buildTenantDb();
    const step = makeStep();
    await expect(
      capturedHandler!({ event: { data: BASE_EVENT }, step }),
    ).rejects.toMatchObject({ name: "NonRetriableError" });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: BASE_RUN_ID }),
      expect.stringContaining("run not found"),
    );
  });

  it("does not produce a completed result when run is not found", async () => {
    buildSystemDbForExecution({ run: null });
    buildTenantDb();
    const step = makeStep();
    let result: unknown;
    try {
      result = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    } catch {
      result = undefined;
    }
    // Must have thrown — any non-thrown result is wrong
    expect(result).toBeUndefined();
  });

  // ── Run not pending ──────────────────────────────────────────────────────────

  it("returns skipped when run is already running", async () => {
    buildSystemDbForExecution({ run: { ...PENDING_RUN, status: "running" } });
    buildTenantDb();
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "skipped" });
  });

  // ── Empty step list ──────────────────────────────────────────────────────────

  it("completes immediately with stepsExecuted=0 when version has no steps", async () => {
    buildSystemDbForExecution({ run: PENDING_RUN, steps: [], edges: [] });
    buildTenantDb();
    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 0 });
  });

  // ── Linear traversal (no edges) ─────────────────────────────────────────────

  it("executes steps in insertion order when no edges exist", async () => {
    const step1 = {
      id: "s1",
      stepKey: "step_a",
      name: "A",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "hello {{git_branch}}" },
    };
    const step2 = {
      id: "s2",
      stepKey: "step_b",
      name: "B",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "world" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [step1, step2],
      edges: [],
    });
    buildTenantDb();

    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "hello main" },
      usage: {},
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 2 });
    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(2);
  });

  // ── Edge-driven traversal ────────────────────────────────────────────────────

  it("follows default edges to traverse in edge order", async () => {
    const step1 = {
      id: "s1",
      stepKey: "a",
      name: "A",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "first" },
    };
    const step2 = {
      id: "s2",
      stepKey: "b",
      name: "B",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "second" },
    };
    const edges = [
      {
        id: "e1",
        sourceStepId: "s1",
        targetStepId: "s2",
        edgeType: "default",
        condition: null,
        priority: 0,
      },
    ];

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [step1, step2],
      edges,
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "result" },
      usage: {},
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 2 });
  });

  // ── Condition step: passes ───────────────────────────────────────────────────

  it("continues traversal when condition passes", async () => {
    const condStep = {
      id: "sc",
      stepKey: "check",
      name: "Check",
      stepType: "condition",
      isAsync: false,
      exitOnError: true,
      config: {
        propertyConditions: [
          { property: "git_branch", operator: "eq", toValue: "main" },
        ],
      },
    };
    const nextStep = {
      id: "sn",
      stepKey: "next",
      name: "Next",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "after condition" },
    };
    const edges = [
      {
        id: "e1",
        sourceStepId: "sc",
        targetStepId: "sn",
        edgeType: "default",
        condition: null,
        priority: 0,
      },
    ];

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [condStep, nextStep],
      edges,
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "done" },
      usage: {},
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 2 });
  });

  // ── Condition step: fails, no false edge ────────────────────────────────────

  it("completes cleanly with condition_not_met reason when condition fails and no false edge", async () => {
    const condStep = {
      id: "sc",
      stepKey: "check",
      name: "Check",
      stepType: "condition",
      isAsync: false,
      exitOnError: true,
      config: {
        propertyConditions: [
          { property: "git_branch", operator: "eq", toValue: "develop" },
        ],
      },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [condStep],
      edges: [],
    });
    buildTenantDb();

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({
      status: "completed",
      reason: "condition_not_met",
    });
  });

  // ── Condition step: fails, follows false edge ────────────────────────────────

  it("follows conditional false-edge when condition fails", async () => {
    const condStep = {
      id: "sc",
      stepKey: "check",
      name: "Check",
      stepType: "condition",
      isAsync: false,
      exitOnError: true,
      config: {
        propertyConditions: [
          { property: "git_branch", operator: "eq", toValue: "develop" },
        ],
      },
    };
    const falseStep = {
      id: "sf",
      stepKey: "fallback",
      name: "Fallback",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "fallback path" },
    };
    const edges = [
      {
        id: "e1",
        sourceStepId: "sc",
        targetStepId: "sf",
        edgeType: "conditional",
        condition: null,
        priority: 0,
      },
    ];

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [condStep, falseStep],
      edges,
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "fallback result" },
      usage: {},
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
  });

  // ── Prompt step ──────────────────────────────────────────────────────────────

  it("interpolates {{key}} placeholders in prompt config", async () => {
    const promptStep = {
      id: "sp",
      stepKey: "greet",
      name: "Greet",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "Hello {{git_branch}}!" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [promptStep],
      edges: [],
    });
    buildTenantDb();

    let capturedPrompt = "";
    mocks.generateObjectFor.mockImplementation(
      async (args: { prompt?: string }) => {
        capturedPrompt = args.prompt ?? "";
        return { object: { output: "Hello main!" }, usage: {} };
      },
    );

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(capturedPrompt).toContain("Hello main!");
  });

  // ── Agent step ───────────────────────────────────────────────────────────────

  it("executes agent step with single-shot LLM completion", async () => {
    const agentStep = {
      id: "sa",
      stepKey: "run_agent",
      name: "RunAgent",
      stepType: "agent",
      isAsync: false,
      exitOnError: true,
      config: { agentSlug: "my-agent", prompt: "Summarise the entity" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [agentStep],
      edges: [],
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "summary text" },
      usage: {},
    });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 1 });
    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const args = mocks.generateObjectFor.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args["telemetry"]).toMatchObject({
      orgId: ORG_ID,
      surface: "runner",
    });
  });

  // ── Tool step: normal capability ─────────────────────────────────────────────

  it("invokes tool capability via kernel.invoke with runner context", async () => {
    const toolStep = {
      id: "st",
      stepKey: "run_tool",
      name: "RunTool",
      stepType: "tool",
      isAsync: false,
      exitOnError: true,
      config: {
        capability: "fetch_web_page",
        input: { url: "https://example.com" },
      },
    };

    mocks.getCapability.mockReturnValue({ agent: { requiresApproval: false } });
    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [toolStep],
      edges: [],
    });
    buildTenantDb();
    mocks.kernelInvoke.mockResolvedValue({ status: 200, body: "page content" });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 1 });
    expect(mocks.kernelInvoke).toHaveBeenCalledWith(
      "fetch_web_page",
      { url: "https://example.com" },
      expect.objectContaining({ surface: "runner", orgId: ORG_ID }),
    );
  });

  // ── Tool step: requiresApproval=true → pause ─────────────────────────────────

  it("pauses run with waiting_approval when tool step has requiresApproval=true", async () => {
    const toolStep = {
      id: "st",
      stepKey: "risky_tool",
      name: "RiskyTool",
      stepType: "tool",
      isAsync: false,
      exitOnError: true,
      config: { capability: "purchase_credits", input: {} },
    };

    mocks.getCapability.mockReturnValue({ agent: { requiresApproval: true } });
    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [toolStep],
      edges: [],
    });
    buildTenantDb();

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "waiting_approval" });
    // kernel.invoke must NOT have been called
    expect(mocks.kernelInvoke).not.toHaveBeenCalled();
  });

  // ── Tool step: null capability contract → no approval check, proceeds ────────

  it("treats null capability (unregistered) as not requiring approval", async () => {
    const toolStep = {
      id: "st",
      stepKey: "tool_xyz",
      name: "ToolXYZ",
      stepType: "tool",
      isAsync: false,
      exitOnError: true,
      config: { capability: "internal.tool.xyz" },
    };

    mocks.getCapability.mockReturnValue(null);
    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [toolStep],
      edges: [],
    });
    buildTenantDb();
    mocks.kernelInvoke.mockResolvedValue({ ok: true });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(mocks.kernelInvoke).toHaveBeenCalled();
  });

  // ── Webhook step ─────────────────────────────────────────────────────────────

  it("POSTs to the configured webhook URL and records the status code", async () => {
    const webhookStep = {
      id: "sw",
      stepKey: "notify",
      name: "Notify",
      stepType: "webhook",
      isAsync: false,
      exitOnError: true,
      config: { url: "https://hooks.example.com/notify" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [webhookStep],
      edges: [],
    });
    buildTenantDb();

    // The fetch call is inside a step.run callback — mock it
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 1 });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.example.com/notify",
      expect.objectContaining({ method: "POST" }),
    );

    vi.unstubAllGlobals();
  });

  it("fails webhook step that uses a non-https URL", async () => {
    const webhookStep = {
      id: "sw",
      stepKey: "unsafe_hook",
      name: "Unsafe",
      stepType: "webhook",
      isAsync: false,
      exitOnError: true,
      config: { url: "http://hooks.example.com/notify" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [webhookStep],
      edges: [],
    });
    buildTenantDb();

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    // exitOnError=true → run should fail
    expect(result).toMatchObject({ status: "failed" });
  });

  it("rejects (SSRF) a webhook step targeting a private/internal IP", async () => {
    const webhookStep = {
      id: "sw",
      stepKey: "ssrf_hook",
      name: "SSRF",
      stepType: "webhook",
      isAsync: false,
      exitOnError: true,
      // 169.254.169.254 is the cloud metadata endpoint — must never be fetched.
      config: { url: "https://169.254.169.254/latest/meta-data/" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [webhookStep],
      edges: [],
    });
    buildTenantDb();

    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    // exitOnError=true → run should fail, and fetch must never be reached.
    expect(result).toMatchObject({ status: "failed" });
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("rejects (SSRF) a webhook step targeting localhost", async () => {
    const webhookStep = {
      id: "sw",
      stepKey: "ssrf_localhost",
      name: "SSRFLocal",
      stepType: "webhook",
      isAsync: false,
      exitOnError: true,
      config: { url: "https://localhost/internal" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [webhookStep],
      edges: [],
    });
    buildTenantDb();

    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // ── human_input step → pause ──────────────────────────────────────────────────

  it("pauses run with waiting_approval for human_input step", async () => {
    const humanStep = {
      id: "sh",
      stepKey: "human_review",
      name: "HumanReview",
      stepType: "human_input",
      isAsync: false,
      exitOnError: true,
      config: {},
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [humanStep],
      edges: [],
    });
    buildTenantDb();

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "waiting_approval" });
  });

  // ── exitOnError=true → run fails ──────────────────────────────────────────────

  it("fails the run when a step throws and exitOnError=true", async () => {
    const badStep = {
      id: "sb",
      stepKey: "bad_step",
      name: "BadStep",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "fail me" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [badStep],
      edges: [],
    });
    buildTenantDb();
    mocks.generateObjectFor.mockRejectedValue(new Error("LLM unavailable"));

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "failed", failedStep: "bad_step" });
  });

  // ── exitOnError=false → continues ────────────────────────────────────────────

  it("records failure and continues to next step when exitOnError=false", async () => {
    const failStep = {
      id: "sf",
      stepKey: "soft_fail",
      name: "SoftFail",
      stepType: "prompt",
      isAsync: false,
      exitOnError: false,
      config: { prompt: "this will fail" },
    };
    const nextStep = {
      id: "sn",
      stepKey: "after_fail",
      name: "AfterFail",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "still runs" },
    };
    const edges = [
      {
        id: "e1",
        sourceStepId: "sf",
        targetStepId: "sn",
        edgeType: "default",
        condition: null,
        priority: 0,
      },
    ];

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [failStep, nextStep],
      edges,
    });
    buildTenantDb();
    mocks.generateObjectFor
      .mockRejectedValueOnce(new Error("first step fails"))
      .mockResolvedValueOnce({
        object: { output: "second step ok" },
        usage: {},
      });

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    // Should complete (second step ran)
    expect(result).toMatchObject({ status: "completed", stepsExecuted: 2 });
    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(2);
  });

  // ── step_runs rows are inserted ───────────────────────────────────────────────

  it("inserts a playbookStepRuns row for each executed step", async () => {
    const singleStep = {
      id: "s1",
      stepKey: "do_thing",
      name: "DoThing",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "do it" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });

    const insertSpy = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "step-run-uuid-1" }]),
    });
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        }),
        insert: () => ({ values: insertSpy }),
      }),
    );

    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "done" },
      usage: {},
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });
    // insertSpy should have been called for step_run, events (multiple), and approvals
    expect(insertSpy).toHaveBeenCalled();
  });

  // ── playbookEvents hash chain ─────────────────────────────────────────────────

  it("emits at least run_started and run_completed events", async () => {
    const singleStep = {
      id: "s1",
      stepKey: "work",
      name: "Work",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "do work" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "done" },
      usage: {},
    });

    const insertedEventTypes: string[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        }),
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            // Capture event_type from playbookEvents inserts
            if ("eventType" in vals) {
              insertedEventTypes.push(vals["eventType"] as string);
            }
            return { returning: vi.fn().mockResolvedValue([{ id: "row-1" }]) };
          },
        }),
      }),
    );

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    expect(insertedEventTypes).toContain("run_started");
    expect(insertedEventTypes).toContain("run_completed");
    expect(insertedEventTypes).toContain("step_started");
    expect(insertedEventTypes).toContain("step_completed");
  });

  // ── ClickHouse telemetry emitted ──────────────────────────────────────────────

  it("calls insertEvents for each executed step and for the final run", async () => {
    const singleStep = {
      id: "s1",
      stepKey: "tel_step",
      name: "TelStep",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "go" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "ok" },
      usage: {},
    });

    const step = makeStep();
    await capturedHandler!({ event: { data: BASE_EVENT }, step });

    // At least 2 insertEvents calls: step telemetry + run-level telemetry
    expect(mocks.insertEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not throw when insertEvents fails (telemetry is non-fatal)", async () => {
    const singleStep = {
      id: "s1",
      stepKey: "tel_step",
      name: "TelStep",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "go" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });
    buildTenantDb();
    mocks.generateObjectFor.mockResolvedValue({
      object: { output: "ok" },
      usage: {},
    });
    mocks.insertEvents.mockRejectedValue(new Error("clickhouse down"));

    const step = makeStep();
    const result = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ telErr: expect.any(Error) }),
      expect.stringContaining("insertEvents failed"),
    );
  });

  it("does not double-insert ClickHouse telemetry when the run is replayed with memoized steps (Inngest retry simulation)", async () => {
    const toolStep = {
      id: "st",
      stepKey: "run_tool",
      name: "RunTool",
      stepType: "tool",
      isAsync: false,
      exitOnError: true,
      config: {
        capability: "fetch_web_page",
        input: { url: "https://example.com" },
      },
    };

    mocks.getCapability.mockReturnValue({ agent: { requiresApproval: false } });
    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [toolStep],
      edges: [],
    });
    buildTenantDb();
    mocks.kernelInvoke.mockResolvedValue({ status: 200, body: "page content" });

    // A single memoizing step shared across two invocations of the handler:
    // this is what "the same Inngest run replays after this point" looks
    // like — every step id that already completed on the first pass returns
    // its cached result on the second pass instead of re-running.
    const step = makeMemoizingStep();

    const first = await capturedHandler!({ event: { data: BASE_EVENT }, step });
    expect(first).toMatchObject({ status: "completed", stepsExecuted: 1 });

    const second = await capturedHandler!({
      event: { data: BASE_EVENT },
      step,
    });
    expect(second).toMatchObject({ status: "completed", stepsExecuted: 1 });

    // Exactly one playbook_step.executed row + one playbook_run.completed
    // row for the single logical run — NOT doubled by the replay. Before
    // the fix these were emitted as plain (un-stepped) code and duplicated
    // on every replay that reached them.
    expect(mocks.insertEvents).toHaveBeenCalledTimes(2);
    // Exactly one tool_invocations row for the single tool step.
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);

    // The event_id / invocation_id baked into the (single) inserted rows are
    // derived deterministically from (runId, stepId) — not crypto.randomUUID().
    const stepTelRow = (
      mocks.insertEvents.mock.calls[0]![0] as Array<Record<string, unknown>>
    )[0]!;
    expect(stepTelRow.event_id).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    const runTelRow = (
      mocks.insertEvents.mock.calls[1]![0] as Array<Record<string, unknown>>
    )[0]!;
    expect(runTelRow.event_id).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  // ── step_run insert failure propagates (bad-fallback fix) ────────────────────

  it("throws from step when playbookStepRuns insert returns no row (DB error)", async () => {
    // This validates the fix for: when the .returning() insert returns [], the
    // step.run callback now throws instead of returning null and breaking out
    // of the loop silently as completed.
    const singleStep = {
      id: "s1",
      stepKey: "insert_fail_step",
      name: "InsertFail",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "should fail" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });

    // Simulate a DB insert that returns an empty rows array (constraint violation
    // or DB error that drizzle surfaces as an empty returning() result).
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        }),
        insert: (_table: unknown) => ({
          values: () => ({
            returning: vi.fn().mockResolvedValue([]), // empty — no row returned
          }),
        }),
      }),
    );

    const step = makeStep();
    // The step.run callback throws — which propagates out of the handler.
    // Under the old code this would have broken out of the loop and returned
    // { status: "completed" } silently.
    await expect(
      capturedHandler!({ event: { data: BASE_EVENT }, step }),
    ).rejects.toThrow("step_run insert returned no row");
  });

  it("does NOT return completed status when playbookStepRuns insert returns no row", async () => {
    // Guards the exact invariant: a missing step_run row must never produce
    // a completed run result from Inngest's perspective.
    const singleStep = {
      id: "s1",
      stepKey: "bad_insert",
      name: "BadInsert",
      stepType: "prompt",
      isAsync: false,
      exitOnError: true,
      config: { prompt: "boom" },
    };

    buildSystemDbForExecution({
      run: PENDING_RUN,
      steps: [singleStep],
      edges: [],
    });

    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: () => ({ where: () => Promise.resolve(undefined) }),
        }),
        insert: () => ({
          values: () => ({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    );

    const step = makeStep();
    let returnedResult: unknown;
    try {
      returnedResult = await capturedHandler!({
        event: { data: BASE_EVENT },
        step,
      });
    } catch {
      returnedResult = undefined;
    }
    // A returned result (no throw) would mean Inngest sees the function as
    // succeeded — that must not happen when the step_run insert failed.
    expect(returnedResult).toBeUndefined();
  });
});
