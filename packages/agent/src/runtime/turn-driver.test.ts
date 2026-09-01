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
  const loadAuthorizationSnapshotFn = vi.fn();
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
    loadAuthorizationSnapshotFn,
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

// The spec contracts are used REAL, not faked: `parseRunSpec` is now a thin
// forward to the centralized legacy parser, and `hydrateAgentRunContext`'s
// whole job is the digest/identity comparison. Stubbing either would leave a
// suite that passes while the checks it exists to prove do nothing. Both leaf
// modules are pure (no DB), so importing them costs nothing.
vi.mock("@oxagen/agent-runner", async () => {
  const legacy = await vi.importActual<
    typeof import("@oxagen/agent-runner/run-spec-v1-legacy")
  >("@oxagen/agent-runner/run-spec-v1-legacy");
  const v2 = await vi.importActual<
    typeof import("@oxagen/agent-runner/run-spec-v2")
  >("@oxagen/agent-runner/run-spec-v2");
  return {
    executeTurn: mocks.executeTurnFn,
    DEFAULT_MAX_AGENT_STEPS: mocks.DEFAULT_MAX_AGENT_STEPS,
    DEFAULT_AGENT_MODEL: mocks.DEFAULT_AGENT_MODEL,
    parseRunSpecV1: legacy.parseRunSpecV1,
    parseRunSpecV2: v2.parseRunSpecV2,
    assertRunRowMatchesSpec: v2.assertRunRowMatchesSpec,
    runSpecV2Digest: v2.runSpecV2Digest,
  };
});

// The impure IAM readers (@oxagen/iam — all DB-backed) are spies; the PURE
// helper the driver uses from @oxagen/oxagen/iam (createAgentRunResolution)
// stays real, so the resolution object attached to ctx.agentRun is the
// genuine {snapshot, byCapability, resolvedAt} shape downstream readers see.
vi.mock("@oxagen/iam", () => ({
  loadAuthorizationSnapshot: mocks.loadAuthorizationSnapshotFn,
  resolveAgentRunAuthzContext: mocks.resolveAgentRunAuthzContextFn,
  fetchAgentRunAuthz: mocks.fetchAgentRunAuthzFn,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScopeFn,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invokeFn,
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
  assertClaimIsLegacyV1,
  hydrateAgentRunContext,
  runRowIdentityFromClaim,
  type ClaimedRun,
} from "./turn-driver";
import {
  runSpecV2Digest,
  type ClaimedRunV2Detail,
  type RunLeaseRef,
} from "@oxagen/agent-runner";
import { isRunSpecIdentityMismatchError } from "@oxagen/agent-runner/run-errors";
import { ONTOLOGY_READ_CAPABILITIES } from "./ontology-tools";

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

  it("unions the ontology read set into the allowlist when toolPolicy.ontology is set", async () => {
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      spec: {
        version: 1,
        instruction: "which accounts are at renewal risk?",
        toolPolicy: { allowlist: ["cap.a"], ontology: true },
      },
    });
    const { io } = makeIo();

    await driver(run, io);

    const [, opts] = mocks.materializeToolsFn.mock.calls[0] as [
      unknown,
      { allowlist: ReadonlySet<string> },
    ];
    // The run's own tool survives; the graph reads join it.
    expect(opts.allowlist.has("cap.a")).toBe(true);
    for (const name of ONTOLOGY_READ_CAPABILITIES) {
      expect(opts.allowlist.has(name), `${name} is missing`).toBe(true);
    }
  });

  it("leaves the allowlist alone when toolPolicy.ontology is absent", async () => {
    // Defaults off: an allowlist that silently grows is not an allowlist.
    const driver = createPlatformTurnDriver();
    const run = makeRun({
      spec: {
        version: 1,
        instruction: "do it",
        toolPolicy: { allowlist: ["cap.a"] },
      },
    });
    const { io } = makeIo();

    await driver(run, io);

    expect(mocks.materializeToolsFn).toHaveBeenCalledWith(expect.anything(), {
      allowlist: new Set(["cap.a"]),
      riskCeiling: undefined,
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

// Engram memory-recall (createPlatformMemoryProvider wired into executeTurn
// as `memory`) is separate agent-memory work whose adapter does not exist on
// main, so it is not part of this driver or these tests.

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

// ═════════════════════════════════════════════════════════════════════════════
// v2 — trusted claim hydration
// ═════════════════════════════════════════════════════════════════════════════
//
// These tests are the security boundary, so the valuable cases are the
// REFUSALS. Hydration is what stands between a tampered `agent_runs` row and a
// model holding a capability ceiling it was never granted, and every one of its
// checks must fail closed independently — a suite that only proved the happy
// path would be green with all four checks deleted.

const V2_UUID = {
  initiating: "11111111-1111-4111-8111-111111111111",
  agentPrincipal: "22222222-2222-4222-8222-222222222222",
  agent: "33333333-3333-4333-8333-333333333333",
  agentVersion: "44444444-4444-4444-8444-444444444444",
  snapshot: "55555555-5555-4555-8555-555555555555",
  connection: "66666666-6666-4666-8666-666666666666",
  environment: "77777777-7777-4777-8777-777777777777",
} as const;

const V2_DIGEST = {
  checksum: `sha256:${"a".repeat(64)}`,
  snapshot: `sha256:${"b".repeat(64)}`,
  ceiling: `sha256:${"c".repeat(64)}`,
  retention: `sha256:${"d".repeat(64)}`,
} as const;

const RETENTION_PUBLIC_ID = `rtn_${"1".repeat(22)}`;

/** A `general` RunSpecV2 — the shape a claimed governed run persists. */
function v2Spec(): Record<string, unknown> {
  return {
    version: 2,
    run_kind: "general",
    goal: "Summarize the incident",
    engine_policy: {
      requested_engine: "ts",
      allowed_engine_versions: ["2.1.0"],
      model_policy_ref: "model-policy:default",
      max_steps: 64,
      max_attempts: 3,
    },
    actor_binding: {
      initiating_principal_id: V2_UUID.initiating,
      agent_principal_id: V2_UUID.agentPrincipal,
      agent_id: V2_UUID.agent,
      agent_version_id: V2_UUID.agentVersion,
      agent_version_checksum: V2_DIGEST.checksum,
    },
    authorization_snapshot_ref: {
      snapshot_id: V2_UUID.snapshot,
      snapshot_digest: V2_DIGEST.snapshot,
      grant_ceiling_digest: V2_DIGEST.ceiling,
      deny_generation_at_admission: { org: "12", workspace: "0" },
      resolved_at: "2026-07-21T10:00:00.000Z",
    },
    workspace_policy: {
      sandbox_required: true,
      environment_id: V2_UUID.environment,
    },
    context_policy: {
      provider_allowlist: ["oxagen.graph"],
      max_frames: 24,
      max_tokens: 32_000,
      retention_policy_id: RETENTION_PUBLIC_ID,
      retention_policy_digest: V2_DIGEST.retention,
    },
    tool_policy: { allowlist: ["ask_graph"], risk_ceiling: "medium" },
  };
}

/**
 * The typed columns the store projects off a claimed v2 row. Built to AGREE
 * with `v2Spec()` — every rejection test below diverges exactly one field, so
 * a failure names the field that broke.
 */
function v2Detail(
  overrides: Partial<ClaimedRunV2Detail> = {},
): ClaimedRunV2Detail {
  const spec = v2Spec();
  return {
    runKind: "general",
    specDigest: runSpecV2Digest(
      spec as unknown as Parameters<typeof runSpecV2Digest>[0],
    ),
    initiatingPrincipalId: V2_UUID.initiating,
    agentPrincipalId: V2_UUID.agentPrincipal,
    agentId: V2_UUID.agent,
    agentVersionId: V2_UUID.agentVersion,
    agentVersionChecksum: V2_DIGEST.checksum,
    authorizationSnapshotId: V2_UUID.snapshot,
    parentRunId: null,
    repositoryBindingId: null,
    repositoryBindingPublicId: null,
    repositoryProvider: null,
    providerRepositoryId: null,
    repositoryConnectionId: null,
    configuredDefaultRef: null,
    baseCommitSha: null,
    baseTreeSha: null,
    retentionPolicyId: "99999999-9999-4999-8999-999999999999",
    retentionPolicyPublicId: RETENTION_PUBLIC_ID,
    retentionPolicyDigest: V2_DIGEST.retention,
    maxAttempts: 3,
    attemptNumber: 1,
    engine: { name: "ts", version: "2.1.0", buildDigest: V2_DIGEST.checksum },
    restore: null,
    ...overrides,
  };
}

const V2_LEASE: RunLeaseRef = {
  runId: "run_1",
  attemptId: "attempt-uuid-1",
  attemptPublicId: `arat_${"2".repeat(22)}`,
  leaseToken: "token-1",
  leaseEpoch: 1,
};

function makeV2Run(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return makeRun({
    spec: v2Spec(),
    specVersion: 2,
    lease: V2_LEASE,
    v2: v2Detail(),
    ...overrides,
  });
}

/** The persisted snapshot, agreeing with the spec's pinned reference. */
function loadedSnapshot() {
  return {
    snapshotId: V2_UUID.snapshot,
    snapshotPublicId: `ras_${"3".repeat(22)}`,
    snapshotDigest: V2_DIGEST.snapshot,
    grantCeilingDigest: V2_DIGEST.ceiling,
    ceiling: {
      agentPrincipalId: V2_UUID.agentPrincipal,
      humanPrincipalId: V2_UUID.initiating,
      assignments: [],
      grants: [],
      parentSnapshotId: null,
      narrowing: null,
    },
    denyGenerationAtAdmission: { org: 12, workspace: 0 },
    nextValidityBoundaryAt: null,
    resolvedAt: "2026-07-21T10:00:00.000Z",
  };
}

describe("assertClaimIsLegacyV1", () => {
  it("passes an explicit v1 claim", () => {
    expect(() =>
      assertClaimIsLegacyV1(makeRun({ specVersion: 1 })),
    ).not.toThrow();
  });

  it("passes a claim with no specVersion (older port, treated as v1)", () => {
    expect(() => assertClaimIsLegacyV1(makeRun())).not.toThrow();
  });

  it("REFUSES a v2 claim — unfenced events would corrupt its evidence chain", () => {
    expect(() => assertClaimIsLegacyV1(makeV2Run())).toThrow(
      /trusted v2 claim/,
    );
  });
});

describe("createPlatformTurnDriver — v2 refusal", () => {
  it("refuses a v2 claim before opening a tenant scope or materializing tools", async () => {
    const driver = createPlatformTurnDriver();
    const { io } = makeIo();
    await expect(driver(makeV2Run(), io)).rejects.toThrow(/trusted v2 claim/);
    expect(mocks.runInTenantScopeFn).not.toHaveBeenCalled();
    expect(mocks.materializeToolsFn).not.toHaveBeenCalled();
    expect(mocks.executeTurnFn).not.toHaveBeenCalled();
  });
});

describe("runRowIdentityFromClaim", () => {
  it("remaps every camelCase column to its snake_case comparator name", () => {
    const identity = runRowIdentityFromClaim(v2Detail());
    expect(identity).toEqual({
      spec_version: 2,
      run_kind: "general",
      spec_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      initiating_principal_id: V2_UUID.initiating,
      agent_principal_id: V2_UUID.agentPrincipal,
      agent_id: V2_UUID.agent,
      agent_version_id: V2_UUID.agentVersion,
      agent_version_checksum: V2_DIGEST.checksum,
      authorization_snapshot_id: V2_UUID.snapshot,
      parent_run_id: null,
      repository_binding_public_id: null,
      provider: null,
      provider_repository_id: null,
      connection_id: null,
      configured_default_ref: null,
      base_commit_sha: null,
      base_tree_sha: null,
      // The PUBLIC id, not the internal uuid — the spec pins `rtn_…`, and
      // comparing the uuid against it would mismatch on every governed run.
      retention_policy_id: RETENTION_PUBLIC_ID,
      retention_policy_digest: V2_DIGEST.retention,
      max_attempts: 3,
    });
  });

  it("carries a repo_edit run's repository columns under the comparator's names", () => {
    const identity = runRowIdentityFromClaim(
      v2Detail({
        runKind: "repo_edit",
        repositoryBindingPublicId: `rpb_${"0".repeat(22)}`,
        repositoryProvider: "github",
        providerRepositoryId: "R_kgDOABCDEF",
        repositoryConnectionId: V2_UUID.connection,
        configuredDefaultRef: "refs/heads/main",
        baseCommitSha: "e".repeat(40),
        baseTreeSha: "f".repeat(40),
      }),
    );
    expect(identity.provider).toBe("github");
    expect(identity.connection_id).toBe(V2_UUID.connection);
    expect(identity.base_commit_sha).toBe("e".repeat(40));
  });
});

describe("hydrateAgentRunContext", () => {
  beforeEach(() => {
    mocks.loadAuthorizationSnapshotFn.mockResolvedValue(loadedSnapshot());
  });

  it("binds both principals, the run/attempt lineage, and the pinned ceiling", async () => {
    const run = makeV2Run();
    const { spec, agentRun } = await hydrateAgentRunContext(run);

    expect(spec.run_kind).toBe("general");
    expect(agentRun.principalKind).toBe("agent");
    expect(agentRun.agentPrincipal).toEqual({
      id: V2_UUID.agentPrincipal,
      kind: "agent",
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(agentRun.humanPrincipal).toEqual({
      id: V2_UUID.initiating,
      kind: "human",
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(agentRun.runId).toBe("run_1");
    expect(agentRun.agentId).toBe(V2_UUID.agent);
    expect(agentRun.parentRunId).toBeNull();
    expect(agentRun.attemptId).toBe("attempt-uuid-1");
    expect(agentRun.authorization?.snapshotDigest).toBe(V2_DIGEST.snapshot);
  });

  it("scopes both principals to the RUN's tenant, never a spec-supplied one", async () => {
    // The spec carries no org/workspace precisely so it cannot claim a tenant.
    // Both principals inherit the claimed row's scope, which RLS already
    // enforced at claim time.
    const { agentRun } = await hydrateAgentRunContext(
      makeV2Run({ orgId: "org-other", workspaceId: "ws-other" }),
    );
    expect(agentRun.agentPrincipal.orgId).toBe("org-other");
    expect(agentRun.humanPrincipal?.workspaceId).toBe("ws-other");
  });

  it("carries the parent run for a subagent dispatch", async () => {
    const parentRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const spec = v2Spec();
    (spec.actor_binding as Record<string, unknown>).parent_run_id = parentRunId;
    const detail = v2Detail({
      parentRunId,
      specDigest: runSpecV2Digest(
        spec as unknown as Parameters<typeof runSpecV2Digest>[0],
      ),
    });
    const { agentRun } = await hydrateAgentRunContext(
      makeV2Run({ spec, v2: detail }),
    );
    expect(agentRun.parentRunId).toBe(parentRunId);
  });

  it("reports a null attemptId when the claim carries no lease", async () => {
    const { agentRun } = await hydrateAgentRunContext(
      makeV2Run({ lease: null }),
    );
    expect(agentRun.attemptId).toBeNull();
  });

  it.each([
    ["a v1 claim", { specVersion: 1 as const, v2: null }],
    ["an unversioned claim", { specVersion: undefined, v2: null }],
    [
      "a v2 claim missing its typed columns",
      { specVersion: 2 as const, v2: null },
    ],
  ])("refuses %s rather than inventing principals", async (_label, patch) => {
    await expect(
      hydrateAgentRunContext(makeV2Run(patch as Partial<ClaimedRun>)),
    ).rejects.toThrow(/not a trusted v2 claim/);
    expect(mocks.loadAuthorizationSnapshotFn).not.toHaveBeenCalled();
  });

  it("refuses a row whose spec_digest does not cover the stored spec", async () => {
    const run = makeV2Run({
      v2: v2Detail({ specDigest: `sha256:${"9".repeat(64)}` }),
    });
    await expect(hydrateAgentRunContext(run)).rejects.toThrow(/digest/i);
    expect(mocks.loadAuthorizationSnapshotFn).not.toHaveBeenCalled();
  });

  it("refuses a row whose typed columns disagree with the spec, naming every field", async () => {
    // Digest recomputed so the identity comparison — not the digest check —
    // is what rejects: otherwise this test would pass for the wrong reason.
    const spec = v2Spec();
    const run = makeV2Run({
      spec,
      v2: v2Detail({
        agentPrincipalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        maxAttempts: 9,
        specDigest: runSpecV2Digest(
          spec as unknown as Parameters<typeof runSpecV2Digest>[0],
        ),
      }),
    });
    await expect(hydrateAgentRunContext(run)).rejects.toSatisfy(
      isRunSpecIdentityMismatchError,
    );
  });

  it("refuses a spec missing its initiating principal", async () => {
    const spec = v2Spec();
    delete (spec.actor_binding as Record<string, unknown>)
      .initiating_principal_id;
    await expect(
      hydrateAgentRunContext(
        makeV2Run({
          spec,
          v2: v2Detail({
            specDigest: runSpecV2Digest(
              spec as unknown as Parameters<typeof runSpecV2Digest>[0],
            ),
          }),
        }),
      ),
    ).rejects.toThrow(/Invalid RunSpecV2/);
  });

  it("refuses a spec missing its agent version binding", async () => {
    const spec = v2Spec();
    delete (spec.actor_binding as Record<string, unknown>).agent_version_id;
    await expect(hydrateAgentRunContext(makeV2Run({ spec }))).rejects.toThrow(
      /Invalid RunSpecV2/,
    );
  });

  it("refuses when the pinned authorization snapshot cannot be loaded", async () => {
    mocks.loadAuthorizationSnapshotFn.mockResolvedValue(null);
    await expect(hydrateAgentRunContext(makeV2Run())).rejects.toThrow(
      /could not be loaded/,
    );
  });

  it("refuses when the loaded snapshot's digest is not the one admission pinned", async () => {
    mocks.loadAuthorizationSnapshotFn.mockResolvedValue({
      ...loadedSnapshot(),
      snapshotDigest: `sha256:${"e".repeat(64)}`,
    });
    await expect(hydrateAgentRunContext(makeV2Run())).rejects.toThrow(
      /does not match the ceiling pinned at admission/,
    );
  });

  it("refuses when the loaded snapshot's grant-ceiling digest was swapped", async () => {
    mocks.loadAuthorizationSnapshotFn.mockResolvedValue({
      ...loadedSnapshot(),
      grantCeilingDigest: `sha256:${"e".repeat(64)}`,
    });
    await expect(hydrateAgentRunContext(makeV2Run())).rejects.toThrow(
      /does not match the ceiling pinned at admission/,
    );
  });

  it("reads the ceiling back by the run's pinned snapshot id — never rebuilds it", async () => {
    await hydrateAgentRunContext(makeV2Run());
    expect(mocks.loadAuthorizationSnapshotFn).toHaveBeenCalledWith(
      V2_UUID.snapshot,
    );
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
    // and the INITIATING user threaded from the enqueue path.
    expect(mocks.resolveAgentRunAuthzContextFn).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      agentId: "agt_1",
      initiatingUserId: "usr_inv",
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
    // The enqueuing human also rides on ctx.userId.
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
