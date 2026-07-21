/**
 * Unit tests for the platform TurnDriver (agent-engine v2 Phase 2 integration
 * — docs/specs/agent-engine-v2/plan.md).
 *
 * House style (matching packages/handlers/src/__tests__/agent.repo.edit.test.ts
 * and packages/agent/src/runtime/materialize-tools.test.ts): hoisted vi.fn
 * doubles + vi.mock module factories for every collaborator this module
 * imports (`./materialize-tools`, `../adapters`, `@oxagen/agent-runner`,
 * `@oxagen/tenancy`, `@oxagen/oxagen/kernel`, `@oxagen/billing`) — never the
 * module under test.
 *
 * `runInTenantScope` is mocked as a spy that STILL invokes its callback (so
 * the turn actually runs) rather than a no-op — this lets "tenant scope wraps
 * the turn" be asserted two ways at once: the scope was requested with the
 * run's orgId/workspaceId, AND materializeTools/executeTurn only fired
 * because the mock's callback ran (proof the turn body executes INSIDE the
 * scope, not merely that a scope was asked for).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const materializeToolsFn = vi.fn();
  const createPlatformAgentAiFn = vi.fn();
  const createPlatformMemoryProviderFn = vi.fn();
  const executeTurnFn = vi.fn();
  const runInTenantScopeFn = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );
  const invokeFn = vi.fn();
  const createTurnBudgetGuardFn = vi.fn();
  const resolveAgentRunAuthzContextFn = vi.fn();
  const fetchAgentRunAuthzFn = vi.fn();
  return {
    materializeToolsFn,
    createPlatformAgentAiFn,
    createPlatformMemoryProviderFn,
    executeTurnFn,
    runInTenantScopeFn,
    invokeFn,
    createTurnBudgetGuardFn,
    resolveAgentRunAuthzContextFn,
    fetchAgentRunAuthzFn,
    // Real value is 256 (packages/agent-engine/src/engine.ts) — mocked here
    // as its own named constant so the "maxSteps" assertion below and the
    // mock's exported value can never drift from each other independently of
    // upstream, even though this file fully replaces the module.
    DEFAULT_MAX_AGENT_STEPS: 256,
    DEFAULT_AGENT_MODEL: "anthropic/claude-fable-5",
  };
});

vi.mock("./materialize-tools", () => ({
  materializeTools: mocks.materializeToolsFn,
}));

vi.mock("../adapters", () => ({
  createPlatformAgentAi: mocks.createPlatformAgentAiFn,
  createPlatformMemoryProvider: mocks.createPlatformMemoryProviderFn,
}));

vi.mock("@oxagen/agent-runner", () => ({
  executeTurn: mocks.executeTurnFn,
  DEFAULT_MAX_AGENT_STEPS: mocks.DEFAULT_MAX_AGENT_STEPS,
  DEFAULT_AGENT_MODEL: mocks.DEFAULT_AGENT_MODEL,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScopeFn,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invokeFn,
}));

// The impure IAM resolvers (@oxagen/iam — DB-backed) are spies; the PURE
// helper the driver uses from @oxagen/oxagen/iam (createAgentRunResolution)
// stays real, so the resolution object attached to ctx.agentRun is the
// genuine {snapshot, byCapability, resolvedAt} shape downstream readers see.
vi.mock("@oxagen/iam", () => ({
  resolveAgentRunAuthzContext: mocks.resolveAgentRunAuthzContextFn,
  fetchAgentRunAuthz: mocks.fetchAgentRunAuthzFn,
}));

// Real implementations of the PURE helpers (governedBudgetFromRead,
// resolveEffectiveTurnBudget, TURN_BUDGET_OFF) — only createTurnBudgetGuard
// itself is a spy, so this suite exercises the actual merge/off-policy logic
// the same way the module under test will see it in production, and only
// fakes the one function with I/O-shaped side effects (hooks).
vi.mock("@oxagen/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@oxagen/billing")>("@oxagen/billing");
  return {
    ...actual,
    createTurnBudgetGuard: mocks.createTurnBudgetGuardFn,
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  createPlatformTurnDriver,
  parseRunSpec,
  type ClaimedRun,
} from "./turn-driver";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    runId: "run_1",
    publicId: "arun_pub1",
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "api-chat",
    spec: { version: 1, instruction: "help me" },
    attempts: 1,
    checkpoint: null,
    checkpointSeq: 0,
    ...overrides,
  };
}

function makeIo(signal: AbortSignal = new AbortController().signal): {
  io: {
    onEvent: ReturnType<typeof vi.fn>;
    checkpoint: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  };
  events: Array<{ type: string; payload: unknown }>;
} {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    events,
    io: {
      onEvent: vi.fn((type: string, payload: unknown) => {
        events.push({ type, payload });
      }),
      checkpoint: vi.fn(async () => {}),
      signal,
    },
  };
}

const fakeAi = { stream: vi.fn(), generateObject: vi.fn() };
const fakeTools = { toolA: {} };
const fakeMemory = {
  recallContext: vi.fn(),
  remember: vi.fn(),
  close: vi.fn(),
};

/** `get_budget_policy`'s own "no governance configured" shape (mirrors
 * packages/handlers/src/workspace.budget_policy.read.ts's no-row default). */
const NO_WORKSPACE_GOVERNANCE = {
  enabled: false,
  limitUsd: null,
  mode: "enforce" as const,
  graceOveragePct: 0.25,
  enforcement: "ceiling" as const,
};

// Minimal shape this suite reads off executeTurn's second argument — avoids
// `any` (the repo's eslint config errors on @typescript-eslint/no-explicit-any).
interface ExecuteTurnCallArgs {
  onStreamPart?: (part: unknown) => void;
  onEvent?: (e: unknown) => void;
}

beforeEach(() => {
  mocks.runInTenantScopeFn.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mocks.materializeToolsFn.mockResolvedValue({
    tools: fakeTools,
    nameMap: { toolA: "real.tool.a" },
    mutatingToolNames: ["toolA"],
  });
  mocks.createPlatformAgentAiFn.mockReturnValue(fakeAi);
  mocks.createPlatformMemoryProviderFn.mockReturnValue(fakeMemory);
  // Default: no workspace/org budget governance configured — resolves to the
  // off policy, so createTurnBudgetGuard (mirroring its real off-policy
  // behavior) returns undefined and executeTurn runs unbudgeted, exactly like
  // every test before this feature existed.
  mocks.invokeFn.mockResolvedValue(NO_WORKSPACE_GOVERNANCE);
  mocks.createTurnBudgetGuardFn.mockReturnValue(undefined);
  mocks.executeTurnFn.mockResolvedValue({
    text: "done",
    steps: 2,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: undefined,
  });
});

// ── parseRunSpec ──────────────────────────────────────────────────────────────

describe("parseRunSpec", () => {
  it("throws a clear, failRun-able error for an unsupported version", () => {
    expect(() => parseRunSpec({ version: 2, instruction: "x" })).toThrow(
      /RunSpec validation failed: unsupported version 2/,
    );
  });

  it("throws a clear error when the spec is not an object", () => {
    expect(() => parseRunSpec(null)).toThrow(/expected an object, got null/);
    expect(() => parseRunSpec("nope")).toThrow(
      /expected an object, got string/,
    );
  });

  it("throws a clear error when a required field (instruction) is missing", () => {
    expect(() => parseRunSpec({ version: 1 })).toThrow(
      /RunSpec validation failed:/,
    );
  });

  it("throws a clear error when instruction is empty", () => {
    expect(() => parseRunSpec({ version: 1, instruction: "" })).toThrow(
      /instruction must not be empty/,
    );
  });

  it("parses a minimal valid v1 spec", () => {
    const parsed = parseRunSpec({ version: 1, instruction: "hi" });
    expect(parsed).toEqual({ version: 1, instruction: "hi" });
  });

  it("accepts an optional toolPolicy with only some of its fields set", () => {
    const parsed = parseRunSpec({
      version: 1,
      instruction: "hi",
      toolPolicy: { riskCeiling: "medium" },
    });
    expect(parsed.toolPolicy).toEqual({ riskCeiling: "medium" });
  });

  it("strips unknown top-level keys instead of rejecting them (forward-compatible)", () => {
    const parsed = parseRunSpec({
      version: 1,
      instruction: "hi",
      somethingFutureAddsLater: true,
    });
    expect(parsed).not.toHaveProperty("somethingFutureAddsLater");
  });

  it("accepts an optional delegation block (agentId/userId, each independently optional)", () => {
    const parsed = parseRunSpec({
      version: 1,
      instruction: "hi",
      delegation: { agentId: "agt_1", userId: "usr_1" },
    });
    expect(parsed.delegation).toEqual({ agentId: "agt_1", userId: "usr_1" });

    const userOnly = parseRunSpec({
      version: 1,
      instruction: "hi",
      delegation: { userId: "usr_1" },
    });
    expect(userOnly.delegation).toEqual({ userId: "usr_1" });
  });
});

// ── createPlatformTurnDriver — spec validation ──────────────────────────────

describe("createPlatformTurnDriver — spec validation", () => {
  it("rejects with a clear message when run.spec fails validation, before opening a tenant scope", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({ spec: { version: 999 } });
    const { io } = makeIo();

    await expect(driver(run, io)).rejects.toThrow(/unsupported version 999/);
    expect(mocks.runInTenantScopeFn).not.toHaveBeenCalled();
    expect(mocks.executeTurnFn).not.toHaveBeenCalled();
  });
});

// ── createPlatformTurnDriver — happy path ───────────────────────────────────

describe("createPlatformTurnDriver — happy path", () => {
  it("maps stream-parts/coding-events/run-result to io.onEvent in order and returns the result", async () => {
    mocks.executeTurnFn.mockImplementation(
      async (_surface: string, opts: ExecuteTurnCallArgs) => {
        opts.onStreamPart?.({ type: "text-delta", text: "hi" });
        opts.onEvent?.({ type: "text", delta: "hi" });
        return {
          text: "final answer",
          steps: 3,
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          stopReason: undefined,
        };
      },
    );

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io, events } = makeIo();

    const outcome = await driver(run, io);

    expect(events.map((e) => e.type)).toEqual([
      "stream-part",
      "coding-event",
      "run-result",
    ]);
    expect(events[0]?.payload).toEqual({ type: "text-delta", text: "hi" });
    expect(events[1]?.payload).toEqual({ type: "text", delta: "hi" });
    expect(events[2]?.payload).toEqual({
      text: "final answer",
      steps: 3,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      stopReason: undefined,
    });
    expect(outcome).toEqual({
      result: {
        text: "final answer",
        steps: 3,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        stopReason: undefined,
      },
    });
  });

  it("builds the CapabilityContext with surface 'runner', requestId = runId, messageId null", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      runId: "run_abc",
      orgId: "org-2",
      workspaceId: "ws-2",
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.materializeToolsFn).toHaveBeenCalledWith(
      {
        orgId: "org-2",
        workspaceId: "ws-2",
        userId: null,
        apiKeyId: null,
        requestId: "run_abc",
        surface: "runner",
        messageId: null,
      },
      expect.anything(),
    );
    expect(mocks.createPlatformAgentAiFn).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "runner", requestId: "run_abc" }),
      "run_abc",
      "runner",
    );
  });

  it("passes toolPolicy.allowlist/riskCeiling through to materializeTools as a Set + riskCeiling", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      spec: {
        version: 1,
        instruction: "do it",
        toolPolicy: { allowlist: ["cap.a", "cap.b"], riskCeiling: "low" },
      },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.materializeToolsFn).toHaveBeenCalledWith(expect.anything(), {
      allowlist: new Set(["cap.a", "cap.b"]),
      riskCeiling: "low",
    });
  });

  it("passes undefined allowlist/riskCeiling to materializeTools when toolPolicy is absent", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({ spec: { version: 1, instruction: "do it" } });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.materializeToolsFn).toHaveBeenCalledWith(expect.anything(), {
      allowlist: undefined,
      riskCeiling: undefined,
    });
  });

  it("passes instruction, history, model, extraTools, mutatingToolNames, and DEFAULT_MAX_AGENT_STEPS to executeTurn", async () => {
    const driver = createPlatformTurnDriver();
    const history = [{ role: "user", content: "hello" }];
    const run = makeRun({
      surface: "api-chat",
      spec: {
        version: 1,
        instruction: "do it",
        model: "claude-x",
        history,
      },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.executeTurnFn).toHaveBeenCalledWith(
      "api-chat",
      expect.objectContaining({
        ai: fakeAi,
        instruction: "do it",
        history,
        model: "claude-x",
        maxSteps: mocks.DEFAULT_MAX_AGENT_STEPS,
        extraTools: fakeTools,
        mutatingToolNames: ["toolA"],
      }),
    );
  });

  it("casts run.surface to PlatformSurface and forwards it as executeTurn's first argument", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({ surface: "a2a" });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.executeTurnFn).toHaveBeenCalledWith("a2a", expect.anything());
  });

  it("passes io.signal through to executeTurn unchanged", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const controller = new AbortController();
    const { io } = makeIo(controller.signal);

    await driver(run, io);

    expect(mocks.executeTurnFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("wraps the turn in the run's tenant scope (orgId/workspaceId), and the turn body runs inside it", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({ orgId: "org-xyz", workspaceId: "ws-xyz" });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.runInTenantScopeFn).toHaveBeenCalledWith(
      { orgId: "org-xyz", workspaceId: "ws-xyz" },
      expect.any(Function),
    );
    // These only fired because the mocked runInTenantScope actually invoked
    // its callback — proof the turn body executes INSIDE the scope, not
    // just that a scope was requested.
    expect(mocks.materializeToolsFn).toHaveBeenCalledTimes(1);
    expect(mocks.executeTurnFn).toHaveBeenCalledTimes(1);
  });
});

// ── createPlatformTurnDriver — memory recall ────────────────────────────────

describe("createPlatformTurnDriver — memory recall", () => {
  it("builds createPlatformMemoryProvider with recallQuery = the spec's instruction and the agent.repo.edit telemetry shape, and passes it to executeTurn as `memory`", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      runId: "run_mem1",
      orgId: "org-mem",
      workspaceId: "ws-mem",
      spec: { version: 1, instruction: "summarize the thread" },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.createPlatformMemoryProviderFn).toHaveBeenCalledWith({
      recallQuery: "summarize the thread",
      telemetry: {
        orgId: "org-mem",
        workspaceId: "ws-mem",
        surface: "runner",
        messageId: "run_mem1",
      },
    });
    expect(mocks.executeTurnFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memory: fakeMemory }),
    );
  });

  it("does not disturb the happy-path event order/outcome when memory is wired in (recall itself degrades inside the adapter, never here)", async () => {
    mocks.executeTurnFn.mockImplementation(
      async (_surface: string, opts: ExecuteTurnCallArgs) => {
        opts.onStreamPart?.({ type: "text-delta", text: "hi" });
        opts.onEvent?.({ type: "text", delta: "hi" });
        return {
          text: "final answer",
          steps: 1,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: undefined,
        };
      },
    );

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io, events } = makeIo();

    const outcome = await driver(run, io);

    expect(events.map((e) => e.type)).toEqual([
      "stream-part",
      "coding-event",
      "run-result",
    ]);
    expect(outcome).toEqual({
      result: {
        text: "final answer",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: undefined,
      },
    });
  });
});

// ── createPlatformTurnDriver — budget guard ─────────────────────────────────

describe("createPlatformTurnDriver — budget guard", () => {
  it("reads workspace/org budget governance via invoke('get_budget_policy', {}, ctx, { surface: 'agent' })", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({ orgId: "org-9", workspaceId: "ws-9" });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.invokeFn).toHaveBeenCalledWith(
      "get_budget_policy",
      {},
      expect.objectContaining({
        orgId: "org-9",
        workspaceId: "ws-9",
        userId: null,
      }),
      { surface: "agent" },
    );
  });

  it("passes no budgetGuard to executeTurn when no workspace governance is configured (off policy)", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.createTurnBudgetGuardFn).toHaveBeenCalledWith(
      { enabled: false, limitUsd: 0, mode: "prompt", graceOveragePct: 0.25 },
      mocks.DEFAULT_AGENT_MODEL,
      expect.objectContaining({ onPause: expect.any(Function) }),
    );
    expect(mocks.executeTurnFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ budgetGuard: undefined }),
    );
  });

  it("resolves an enabled workspace budget ceiling into the effective TurnBudgetPolicy and wires the resulting guard through to executeTurn", async () => {
    mocks.invokeFn.mockResolvedValue({
      enabled: true,
      limitUsd: 5,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
    const fakeGuard = vi.fn();
    mocks.createTurnBudgetGuardFn.mockReturnValue(fakeGuard);

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io } = makeIo();

    await driver(run, io);

    // TURN_BUDGET_OFF (no member policy) + a "ceiling" workspace governance ⇒
    // resolveEffectiveTurnBudget's applyCeiling forces enabled:true, clamps
    // limitUsd down to the ceiling, and takes the stricter mode.
    expect(mocks.createTurnBudgetGuardFn).toHaveBeenCalledWith(
      { enabled: true, limitUsd: 5, mode: "enforce", graceOveragePct: 0.25 },
      mocks.DEFAULT_AGENT_MODEL,
      expect.anything(),
    );
    expect(mocks.executeTurnFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ budgetGuard: fakeGuard }),
    );
  });

  it("uses spec.model (not DEFAULT_AGENT_MODEL) for budget-guard cost pricing when the RunSpec sets one", async () => {
    mocks.invokeFn.mockResolvedValue({
      enabled: true,
      limitUsd: 2,
      mode: "grace",
      graceOveragePct: 0.1,
      enforcement: "default",
    });

    const driver = createPlatformTurnDriver();
    const run = makeRun({
      spec: { version: 1, instruction: "hi", model: "claude-x" },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.createTurnBudgetGuardFn).toHaveBeenCalledWith(
      expect.anything(),
      "claude-x",
      expect.anything(),
    );
  });

  it("fails open to an unbudgeted turn when the get_budget_policy read rejects (no_handler / IAM deny / DB error)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invokeFn.mockRejectedValue(
      new Error('Unknown capability "get_budget_policy"'),
    );

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io } = makeIo();

    const outcome = await driver(run, io);

    expect(outcome).toBeDefined();
    expect(mocks.createTurnBudgetGuardFn).toHaveBeenCalledWith(
      { enabled: false, limitUsd: 0, mode: "prompt", graceOveragePct: 0.25 },
      mocks.DEFAULT_AGENT_MODEL,
      expect.anything(),
    );
    expect(mocks.executeTurnFn).toHaveBeenCalledTimes(1);
  });

  it("denies (stops) rather than pausing on a budget approval prompt — no interactive approver on the durable-run worker", async () => {
    mocks.invokeFn.mockResolvedValue({
      enabled: true,
      limitUsd: 1,
      mode: "prompt",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io } = makeIo();

    await driver(run, io);

    const hooks = mocks.createTurnBudgetGuardFn.mock.calls[0]?.[2] as {
      onPause: () => boolean | Promise<boolean>;
    };
    await expect(Promise.resolve(hooks.onPause())).resolves.toBe(false);
  });

  it("surfaces a budget stop through the existing run-result stopReason (no separate event wiring needed)", async () => {
    mocks.executeTurnFn.mockResolvedValue({
      text: "partial answer",
      steps: 4,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      stopReason: "budget",
    });

    const driver = createPlatformTurnDriver();
    const run = makeRun();
    const { io, events } = makeIo();

    const outcome = await driver(run, io);

    const runResult = events.find((e) => e.type === "run-result");
    expect(runResult?.payload).toEqual(
      expect.objectContaining({ stopReason: "budget" }),
    );
    expect(outcome).toEqual({
      result: expect.objectContaining({ stopReason: "budget" }),
    });
  });
});

// ── createPlatformTurnDriver — agent RBAC delegation (spec §3.4/§3.5) ───────
//
// A delegated run (spec.delegation.agentId) resolves the two-principal
// delegation ceiling, prefetches the once-per-run authz snapshot, and hands
// materializeTools a CapabilityContext carrying `agentRun` — activating both
// the kernel IAM gate and the model-facing tool filter from ONE resolution.

// Minimal shape this suite reads off materializeTools' first argument.
interface CtxWithAgentRun {
  userId: string | null;
  agentRun?: {
    principalKind: string;
    agentPrincipal: unknown;
    humanPrincipal: unknown;
    agentId: string;
    runId: string;
    parentRunId: string | null;
    resolution?: { snapshot: unknown; byCapability: Map<string, unknown> };
  };
}

describe("createPlatformTurnDriver — agent RBAC delegation (spec §3.4/§3.5)", () => {
  const AGENT_PRINCIPAL = {
    id: "prn-agent-1",
    kind: "agent" as const,
    orgId: "org-1",
    workspaceId: "ws-1",
  };
  const HUMAN_PRINCIPAL = {
    id: "prn-human-1",
    kind: "human" as const,
    orgId: "org-1",
    workspaceId: null,
  };
  const SNAPSHOT = { grants: [], roles: [], roleGrants: [], policies: [] };

  function delegatedRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
    return makeRun({
      runId: "run_del1",
      spec: {
        version: 1,
        instruction: "act as the agent",
        delegation: { agentId: "agt_1", userId: "usr_inv" },
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    mocks.resolveAgentRunAuthzContextFn.mockResolvedValue({
      principalKind: "agent",
      agentPrincipal: AGENT_PRINCIPAL,
      humanPrincipal: HUMAN_PRINCIPAL,
    });
    mocks.fetchAgentRunAuthzFn.mockResolvedValue(SNAPSHOT);
  });

  it("attaches ctx.agentRun with BOTH principals, run lineage, and a prefetched resolution built from the fetched snapshot", async () => {
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();

    await driver(delegatedRun(), io);

    // The ceiling is resolved for the run's org/workspace, the named agent,
    // and the INVOKING user threaded from the enqueue path.
    expect(mocks.resolveAgentRunAuthzContextFn).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      agentId: "agt_1",
      invokingUserId: "usr_inv",
    });
    // The once-per-run snapshot covers BOTH principals of the ceiling.
    expect(mocks.fetchAgentRunAuthzFn).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      agentPrincipalId: "prn-agent-1",
      humanPrincipalId: "prn-human-1",
    });

    const ctx = mocks.materializeToolsFn.mock.calls[0]?.[0] as CtxWithAgentRun;
    expect(ctx.agentRun).toBeDefined();
    expect(ctx.agentRun).toMatchObject({
      principalKind: "agent",
      agentId: "agt_1",
      runId: "run_del1",
      parentRunId: null,
    });
    // Both principals ride on the context — by reference, no copies.
    expect(ctx.agentRun?.agentPrincipal).toBe(AGENT_PRINCIPAL);
    expect(ctx.agentRun?.humanPrincipal).toBe(HUMAN_PRINCIPAL);
    // The resolution cache is PRE-populated (materializeTools filters from it
    // before the first kernel check) and wraps the exact fetched snapshot.
    expect(ctx.agentRun?.resolution?.snapshot).toBe(SNAPSHOT);
    expect(ctx.agentRun?.resolution?.byCapability).toBeInstanceOf(Map);
    expect(ctx.agentRun?.resolution?.byCapability.size).toBe(0);
    // The enqueuing human also rides on ctx.userId (honest attribution).
    expect(ctx.userId).toBe("usr_inv");
  });

  it("fails the run (throws → failRun) when the agent identity cannot be resolved — never executes ungoverned", async () => {
    mocks.resolveAgentRunAuthzContextFn.mockResolvedValue(null);
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();

    await expect(driver(delegatedRun(), io)).rejects.toThrow(
      /agent "agt_1" could not be resolved to a live agent principal/,
    );
    expect(mocks.materializeToolsFn).not.toHaveBeenCalled();
    expect(mocks.executeTurnFn).not.toHaveBeenCalled();
  });

  it("passes a null humanPrincipal through to the snapshot fetch and the run context (sentinel ceiling downstream)", async () => {
    mocks.resolveAgentRunAuthzContextFn.mockResolvedValue({
      principalKind: "agent",
      agentPrincipal: AGENT_PRINCIPAL,
      humanPrincipal: null,
    });
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();

    await driver(delegatedRun(), io);

    expect(mocks.fetchAgentRunAuthzFn).toHaveBeenCalledWith(
      expect.objectContaining({ humanPrincipalId: null }),
    );
    const ctx = mocks.materializeToolsFn.mock.calls[0]?.[0] as CtxWithAgentRun;
    expect(ctx.agentRun?.humanPrincipal).toBeNull();
  });

  it("the driver's own budget-governance read carries NO agentRun — an agent role can never unbind workspace budget", async () => {
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();

    await driver(delegatedRun(), io);

    expect(mocks.invokeFn).toHaveBeenCalledWith(
      "get_budget_policy",
      {},
      expect.anything(),
      { surface: "agent" },
    );
    const budgetCtx = mocks.invokeFn.mock.calls[0]?.[2] as CtxWithAgentRun;
    expect("agentRun" in budgetCtx).toBe(false);
    // …but the model-facing context DOES carry it.
    const toolCtx = mocks.materializeToolsFn.mock
      .calls[0]?.[0] as CtxWithAgentRun;
    expect(toolCtx.agentRun).toBeDefined();
  });

  it("delegation with userId but NO agentId: userId rides on ctx, no agentRun, IAM resolvers untouched", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      spec: {
        version: 1,
        instruction: "hi",
        delegation: { userId: "usr_only" },
      },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.resolveAgentRunAuthzContextFn).not.toHaveBeenCalled();
    expect(mocks.fetchAgentRunAuthzFn).not.toHaveBeenCalled();
    const ctx = mocks.materializeToolsFn.mock.calls[0]?.[0] as CtxWithAgentRun;
    expect(ctx.userId).toBe("usr_only");
    expect("agentRun" in ctx).toBe(false);
  });

  it("non-delegated specs never touch the IAM resolvers and build the exact pre-RBAC context (no agentRun key)", async () => {
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();

    await driver(makeRun(), io);

    expect(mocks.resolveAgentRunAuthzContextFn).not.toHaveBeenCalled();
    expect(mocks.fetchAgentRunAuthzFn).not.toHaveBeenCalled();
    const ctx = mocks.materializeToolsFn.mock.calls[0]?.[0] as CtxWithAgentRun;
    expect("agentRun" in ctx).toBe(false);
    expect(ctx.userId).toBeNull();
  });
});
