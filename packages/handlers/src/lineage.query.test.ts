/**
 * lineage.query handler tests.
 *
 * Strategy: the tree-shape/outcome/truncation/principal-resolution logic
 * lives in the pure `assembleLineageTree` (+ `deriveLineageOutcome` /
 * `parseDelegationViolation`) functions and is tested directly, with zero DB
 * or ClickHouse mocking. A smaller set of handler-level tests then proves the
 * wiring: not-found, a full multi-level happy path, ClickHouse degrading to
 * zero spend, and the node cap.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NIL_UUID, type TokenUsageByStepRow } from "@oxagen/telemetry";

const mocks = vi.hoisted(() => ({
  sumTokenUsageByExecutionStep: vi.fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    sumTokenUsageByExecutionStep: mocks.sumTokenUsageByExecutionStep,
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { logger } from "./logger";
import {
  assembleLineageTree,
  deriveLineageOutcome,
  parseDelegationViolation,
  lineageQueryHandler,
} from "./lineage.query";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ---------------------------------------------------------------------------
// deriveLineageOutcome — pure
// ---------------------------------------------------------------------------

describe("deriveLineageOutcome", () => {
  it("passes pending/running/completed through unchanged", () => {
    expect(deriveLineageOutcome("pending", null)).toBe("pending");
    expect(deriveLineageOutcome("running", null)).toBe("running");
    expect(deriveLineageOutcome("completed", null)).toBe("completed");
  });

  it("maps a genuine failure to 'failed'", () => {
    expect(deriveLineageOutcome("failed", "dispatch emit failed: boom")).toBe(
      "failed",
    );
    expect(deriveLineageOutcome("failed", null)).toBe("failed");
  });

  it("maps the exact cancel error_reason to 'cancelled', distinct from 'failed'", () => {
    expect(
      deriveLineageOutcome("failed", "Cancelled by agent.subagent.cancel"),
    ).toBe("cancelled");
  });

  it("does not treat a reason merely containing 'Cancelled' as a cancellation", () => {
    expect(
      deriveLineageOutcome("failed", "Cancelled something else entirely"),
    ).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// parseDelegationViolation — pure
// ---------------------------------------------------------------------------

describe("parseDelegationViolation", () => {
  it("is null for a non-failed status", () => {
    expect(
      parseDelegationViolation(
        "completed",
        'IAM denied "x" for principal: no_grant',
      ),
    ).toBeNull();
    expect(parseDelegationViolation("pending", null)).toBeNull();
  });

  it("is null when error_reason is null", () => {
    expect(parseDelegationViolation("failed", null)).toBeNull();
  });

  it("is null for a cancellation (not an IAM denial)", () => {
    expect(
      parseDelegationViolation("failed", "Cancelled by agent.subagent.cancel"),
    ).toBeNull();
  });

  it("parses the kernel's IAM-denial message shape", () => {
    const msg = 'IAM denied "run_capability_chain" for principal: no_grant';
    expect(parseDelegationViolation("failed", msg)).toEqual({
      ruleId: "no_grant",
      message: msg,
    });
  });

  it("parses the kernel's pending-approval message shape", () => {
    const msg =
      'IAM requires approval for "run_capability_chain" — the action is denied pending approval.';
    expect(parseDelegationViolation("failed", msg)).toEqual({
      ruleId: "pending_approval",
      message: msg,
    });
  });

  it("is null for a failure that is neither a cancellation nor an IAM denial", () => {
    expect(
      parseDelegationViolation(
        "failed",
        "dispatch emit failed: INNGEST_EVENT_KEY missing",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assembleLineageTree — pure
// ---------------------------------------------------------------------------

function treeRow(
  overrides: Partial<
    Parameters<typeof assembleLineageTree>[0]["rows"][number]
  > = {},
) {
  return {
    public_id: "sar_default",
    child_message_id: "step_default",
    capability_name: "read_file",
    status: "completed",
    error_reason: null,
    started_at: new Date("2026-07-21T00:00:00Z"),
    completed_at: new Date("2026-07-21T00:00:02Z"),
    attempts: 1,
    parent_run_public_id: null,
    own_fanout_public_id: "fan_root",
    depth: 0,
    child_fanout_id: null,
    ...overrides,
  };
}

describe("assembleLineageTree", () => {
  it("wires parentRunId across a multi-level tree (depth 0 -> 1 -> 2)", () => {
    const rows = [
      treeRow({
        public_id: "sar_1",
        child_message_id: "step_1",
        depth: 0,
        parent_run_public_id: null,
        own_fanout_public_id: "fan_root",
        child_fanout_id: "fan_nested_1",
      }),
      treeRow({
        public_id: "sar_2",
        child_message_id: "step_2",
        depth: 1,
        parent_run_public_id: "sar_1",
        own_fanout_public_id: "fan_nested_1",
        child_fanout_id: "fan_nested_2",
      }),
      treeRow({
        public_id: "sar_3",
        child_message_id: "step_3",
        depth: 2,
        parent_run_public_id: "sar_2",
        own_fanout_public_id: "fan_nested_2",
        child_fanout_id: null,
      }),
    ];

    const { nodes, truncated } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map(),
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });

    expect(truncated).toBe(false);
    expect(
      nodes.map((n) => [
        n.runId,
        n.depth,
        n.parentRunId,
        n.fanoutId,
        n.childFanoutId,
      ]),
    ).toEqual([
      ["sar_1", 0, null, "fan_root", "fan_nested_1"],
      ["sar_2", 1, "sar_1", "fan_nested_1", "fan_nested_2"],
      ["sar_3", 2, "sar_2", "fan_nested_2", null],
    ]);
  });

  it("truncates to maxNodes and reports truncated: true", () => {
    const rows = [
      treeRow({ public_id: "sar_1", child_message_id: "step_1" }),
      treeRow({ public_id: "sar_2", child_message_id: "step_2" }),
      treeRow({ public_id: "sar_3", child_message_id: "step_3" }),
    ];

    const { nodes, truncated } = assembleLineageTree({
      rows,
      maxNodes: 2,
      spendByStepId: new Map(),
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });

    expect(truncated).toBe(true);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.runId)).toEqual(["sar_1", "sar_2"]);
  });

  it("does not truncate when rows.length === maxNodes exactly", () => {
    const rows = [
      treeRow({ public_id: "sar_1", child_message_id: "step_1" }),
      treeRow({ public_id: "sar_2", child_message_id: "step_2" }),
    ];
    const { truncated, nodes } = assembleLineageTree({
      rows,
      maxNodes: 2,
      spendByStepId: new Map(),
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });
    expect(truncated).toBe(false);
    expect(nodes).toHaveLength(2);
  });

  it("resolves principal + delegation ceiling for an agent principal, converts micros to USD", () => {
    const usage: TokenUsageByStepRow = {
      executionStepId: "step_1",
      costMicros: 1_250_000,
      inputTokens: 100,
      outputTokens: 50,
      llmCalls: 2,
      model: "claude-sonnet-5",
      provider: "anthropic",
      principalId: "prn_agent_1",
      principalKind: "agent",
    };
    const rows = [treeRow({ public_id: "sar_1", child_message_id: "step_1" })];

    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map([["step_1", usage]]),
      principalsById: new Map([
        [
          "prn_agent_1",
          {
            id: "prn_agent_1",
            kind: "agent",
            displayName: "Research Agent",
            parentUserId: "user_1",
            status: "active",
          },
        ],
      ]),
      ceilingByParentUserId: new Map([
        ["user_1", { id: "prn_human_ceiling", displayName: "Jane Doe" }],
      ]),
    });

    expect(nodes[0]!.principal).toEqual({
      id: "prn_agent_1",
      kind: "agent",
      displayName: "Research Agent",
    });
    expect(nodes[0]!.delegationCeiling).toEqual({
      principalId: "prn_human_ceiling",
      displayName: "Jane Doe",
    });
    expect(nodes[0]!.spend).toEqual({
      costUsd: 1.25,
      inputTokens: 100,
      outputTokens: 50,
      llmCalls: 2,
    });
    expect(nodes[0]!.model).toBe("claude-sonnet-5");
    expect(nodes[0]!.provider).toBe("anthropic");
  });

  it("never surfaces a bare id — unresolved principal falls back to 'Unknown principal', zero spend", () => {
    const rows = [treeRow({ public_id: "sar_1", child_message_id: "step_1" })];
    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map(), // no usage row for step_1 at all
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });
    expect(nodes[0]!.principal).toEqual({
      id: null,
      kind: null,
      displayName: "Unknown principal",
    });
    expect(nodes[0]!.delegationCeiling).toBeNull();
    expect(nodes[0]!.spend).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
    });
    expect(nodes[0]!.model).toBeNull();
    expect(nodes[0]!.provider).toBeNull();
  });

  it("gives a human/service principal no delegation ceiling", () => {
    const usage: TokenUsageByStepRow = {
      executionStepId: "step_1",
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      model: "",
      provider: "",
      principalId: "prn_human_1",
      principalKind: "human",
    };
    const rows = [treeRow({ public_id: "sar_1", child_message_id: "step_1" })];
    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map([["step_1", usage]]),
      principalsById: new Map([
        [
          "prn_human_1",
          {
            id: "prn_human_1",
            kind: "human",
            displayName: "Jane Doe",
            parentUserId: null,
            status: "active",
          },
        ],
      ]),
      ceilingByParentUserId: new Map(),
    });
    expect(nodes[0]!.principal.kind).toBe("human");
    expect(nodes[0]!.delegationCeiling).toBeNull();
  });

  it("treats the NIL_UUID principal sentinel as unresolved", () => {
    const usage: TokenUsageByStepRow = {
      executionStepId: "step_1",
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      model: "",
      provider: "",
      principalId: NIL_UUID,
      principalKind: "",
    };
    const rows = [treeRow({ public_id: "sar_1", child_message_id: "step_1" })];
    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map([["step_1", usage]]),
      principalsById: new Map([
        [
          NIL_UUID,
          {
            id: NIL_UUID,
            kind: "service",
            displayName: "should not appear",
            parentUserId: null,
            status: "active",
          },
        ],
      ]),
      ceilingByParentUserId: new Map(),
    });
    expect(nodes[0]!.principal).toEqual({
      id: null,
      kind: null,
      displayName: "Unknown principal",
    });
  });

  it("derives outcome and delegationViolation per node from status/error_reason", () => {
    const rows = [
      treeRow({ public_id: "sar_ok", status: "completed", error_reason: null }),
      treeRow({
        public_id: "sar_cancelled",
        child_message_id: "step_cancelled",
        status: "failed",
        error_reason: "Cancelled by agent.subagent.cancel",
      }),
      treeRow({
        public_id: "sar_denied",
        child_message_id: "step_denied",
        status: "failed",
        error_reason:
          'IAM denied "run_capability_chain" for principal: no_grant',
      }),
    ];
    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map(),
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });
    expect(nodes[0]!.outcome).toBe("completed");
    expect(nodes[0]!.delegationViolation).toBeNull();
    expect(nodes[1]!.outcome).toBe("cancelled");
    expect(nodes[1]!.delegationViolation).toBeNull();
    expect(nodes[2]!.outcome).toBe("failed");
    expect(nodes[2]!.delegationViolation).toEqual({
      ruleId: "no_grant",
      message: 'IAM denied "run_capability_chain" for principal: no_grant',
    });
  });

  it("nulls durationMs/startedAt/completedAt for a run that has not started", () => {
    const rows = [
      treeRow({
        public_id: "sar_pending",
        status: "pending",
        started_at: null,
        completed_at: null,
      }),
    ];
    const { nodes } = assembleLineageTree({
      rows,
      maxNodes: 200,
      spendByStepId: new Map(),
      principalsById: new Map(),
      ceilingByParentUserId: new Map(),
    });
    expect(nodes[0]!.startedAt).toBeNull();
    expect(nodes[0]!.completedAt).toBeNull();
    expect(nodes[0]!.durationMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lineageQueryHandler — wiring
// ---------------------------------------------------------------------------

// Queues one fake `tx` per withTenantDb call, in call order. Each fake
// supports whichever chain the handler actually issues at that step:
//   - fanout lookup:   select().from().where().limit()
//   - tree walk:       execute()
//   - principal batch: select().from().where()   (no .limit())
function selectChain(result: unknown, withLimit = false) {
  const where = () =>
    withLimit
      ? { limit: () => Promise.resolve(result) }
      : Promise.resolve(result);
  return { select: () => ({ from: () => ({ where }) }) };
}

function queueTx(...txs: unknown[]) {
  let i = 0;
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const tx = txs[i];
    i += 1;
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
}

const ROOT_FANOUT_ROW = {
  id: "fanuuid_root",
  publicId: "fan_root",
  status: "partial",
  totalChildren: 2,
  completedChildren: 1,
  createdAt: new Date("2026-07-21T00:00:00Z"),
  updatedAt: new Date("2026-07-21T00:00:10Z"),
};

describe("lineageQueryHandler", () => {
  beforeEach(() => {
    vi.mocked(withTenantDb).mockReset();
    mocks.sumTokenUsageByExecutionStep.mockReset();
    vi.mocked(logger.error).mockClear();
  });

  it("throws FanoutNotFoundError for an unknown/cross-tenant dispatchId", async () => {
    queueTx(selectChain([], true));
    await expect(
      lineageQueryHandler(
        { dispatchId: "fan_missing", maxDepth: 5, maxNodes: 200 },
        CTX,
      ),
    ).rejects.toThrow("Fanout fan_missing not found");
    expect(mocks.sumTokenUsageByExecutionStep).not.toHaveBeenCalled();
  });

  it("assembles a full multi-level tree with spend, principal, and delegation ceiling", async () => {
    const treeRows = [
      {
        public_id: "sar_1",
        child_message_id: "step_1",
        capability_name: "run_capability_chain",
        status: "completed",
        error_reason: null,
        started_at: new Date("2026-07-21T00:00:00Z"),
        completed_at: new Date("2026-07-21T00:00:05Z"),
        attempts: 1,
        parent_run_public_id: null,
        own_fanout_public_id: "fan_root",
        depth: 0,
        child_fanout_id: "fan_nested",
      },
      {
        public_id: "sar_2",
        child_message_id: "step_2",
        capability_name: "recall_memory",
        status: "failed",
        error_reason: "Cancelled by agent.subagent.cancel",
        started_at: null,
        completed_at: new Date("2026-07-21T00:00:01Z"),
        attempts: 0,
        parent_run_public_id: null,
        own_fanout_public_id: "fan_root",
        depth: 0,
        child_fanout_id: null,
      },
      {
        public_id: "sar_3",
        child_message_id: "step_3",
        capability_name: "search_graph",
        status: "running",
        error_reason: null,
        started_at: new Date("2026-07-21T00:00:02Z"),
        completed_at: null,
        attempts: 1,
        parent_run_public_id: "sar_1",
        own_fanout_public_id: "fan_nested",
        depth: 1,
        child_fanout_id: null,
      },
    ];
    mocks.sumTokenUsageByExecutionStep.mockResolvedValue(
      new Map<string, TokenUsageByStepRow>([
        [
          "step_1",
          {
            executionStepId: "step_1",
            costMicros: 500_000,
            inputTokens: 100,
            outputTokens: 50,
            llmCalls: 1,
            model: "claude-sonnet-5",
            provider: "anthropic",
            principalId: "prn_agent_1",
            principalKind: "agent",
          },
        ],
        [
          "step_3",
          {
            executionStepId: "step_3",
            costMicros: 0,
            inputTokens: 10,
            outputTokens: 5,
            llmCalls: 1,
            model: "claude-haiku",
            provider: "anthropic",
            principalId: "prn_human_1",
            principalKind: "human",
          },
        ],
      ]),
    );

    queueTx(
      selectChain([ROOT_FANOUT_ROW], true), // 1. fanout lookup
      { execute: () => Promise.resolve(treeRows) }, // 2. tree walk
      selectChain([
        {
          id: "prn_agent_1",
          kind: "agent",
          displayName: "Research Agent",
          parentUserId: "user_1",
          status: "active",
        },
        {
          id: "prn_human_1",
          kind: "human",
          displayName: "Bob Runner",
          parentUserId: null,
          status: "active",
        },
      ]), // 3. principal batch
      selectChain([
        {
          id: "prn_human_ceiling",
          displayName: "Jane Doe",
          parentUserId: "user_1",
        },
      ]), // 4. ceiling batch
    );

    const out = await lineageQueryHandler(
      { dispatchId: "fan_root", maxDepth: 5, maxNodes: 200 },
      CTX,
    );

    expect(out.dispatchId).toBe("fan_root");
    expect(out.rootStatus).toBe("partial");
    expect(out.nodeCount).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.maxDepthReached).toBe(false);

    const [n1, n2, n3] = out.nodes;
    expect(n1).toMatchObject({
      runId: "sar_1",
      parentRunId: null,
      depth: 0,
      outcome: "completed",
      principal: {
        id: "prn_agent_1",
        kind: "agent",
        displayName: "Research Agent",
      },
      delegationCeiling: {
        principalId: "prn_human_ceiling",
        displayName: "Jane Doe",
      },
    });
    expect(n1!.spend.costUsd).toBe(0.5);

    expect(n2).toMatchObject({
      runId: "sar_2",
      outcome: "cancelled",
      principal: { id: null, kind: null, displayName: "Unknown principal" },
    });

    expect(n3).toMatchObject({
      runId: "sar_3",
      parentRunId: "sar_1",
      fanoutId: "fan_nested",
      depth: 1,
      outcome: "running",
      principal: {
        id: "prn_human_1",
        kind: "human",
        displayName: "Bob Runner",
      },
      delegationCeiling: null,
    });
  });

  it("degrades every node to zero spend / unresolved principal when ClickHouse fails, without failing the read", async () => {
    const treeRows = [
      {
        public_id: "sar_1",
        child_message_id: "step_1",
        capability_name: "read_file",
        status: "completed",
        error_reason: null,
        started_at: new Date("2026-07-21T00:00:00Z"),
        completed_at: new Date("2026-07-21T00:00:01Z"),
        attempts: 1,
        parent_run_public_id: null,
        own_fanout_public_id: "fan_root",
        depth: 0,
        child_fanout_id: null,
      },
    ];
    mocks.sumTokenUsageByExecutionStep.mockRejectedValue(
      new Error("clickhouse unavailable"),
    );
    queueTx(
      selectChain([ROOT_FANOUT_ROW], true), // 1. fanout lookup
      { execute: () => Promise.resolve(treeRows) }, // 2. tree walk
      // No further withTenantDb calls: zero resolved principal ids => the
      // principal/ceiling batches are skipped entirely.
    );

    const out = await lineageQueryHandler(
      { dispatchId: "fan_root", maxDepth: 5, maxNodes: 200 },
      CTX,
    );

    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]!.spend).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
    });
    expect(out.nodes[0]!.principal).toEqual({
      id: null,
      kind: null,
      displayName: "Unknown principal",
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("enforces the node cap and reports truncated: true", async () => {
    const treeRows = Array.from({ length: 3 }, (_, i) => ({
      public_id: `sar_${i}`,
      child_message_id: `step_${i}`,
      capability_name: "read_file",
      status: "completed",
      error_reason: null,
      started_at: new Date("2026-07-21T00:00:00Z"),
      completed_at: new Date("2026-07-21T00:00:01Z"),
      attempts: 1,
      parent_run_public_id: null,
      own_fanout_public_id: "fan_root",
      depth: 0,
      child_fanout_id: null,
    }));
    mocks.sumTokenUsageByExecutionStep.mockResolvedValue(new Map());
    queueTx(selectChain([ROOT_FANOUT_ROW], true), {
      execute: () => Promise.resolve(treeRows),
    });

    const out = await lineageQueryHandler(
      { dispatchId: "fan_root", maxDepth: 5, maxNodes: 2 },
      CTX,
    );

    expect(out.truncated).toBe(true);
    expect(out.nodeCount).toBe(2);
    expect(out.nodes).toHaveLength(2);
  });
});
