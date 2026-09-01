import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Postgres mock ────────────────────────────────────────────────────────
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

// ── Neo4j mock — keep the real NodeLabels/EdgeTypes constants, replace only
// scopedSession so no real driver connection is ever attempted. ───────────
const mocks = vi.hoisted(() => ({
  sessionRun: vi.fn(
    async (_cypher: string, _params?: Record<string, unknown>) =>
      ({ records: [] }) as unknown,
  ),
  sessionClose: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/ontology", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/ontology")>();
  return {
    ...real,
    scopedSession: vi.fn(() => ({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    })),
  };
});

import { withTenantDb } from "@oxagen/database";
import { scopedSession } from "@oxagen/ontology";
import {
  projectExecutionToolUsage,
  type ProjectExecutionToolUsageArgs,
} from "./tool-projection";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const EXECUTION_ID = "33333333-3333-3333-3333-333333333333";

interface ToolUsageFixture {
  tool_type: string;
  tool_name: string;
  call_count: number;
  failed_call_count: number;
  first_invoked_at: Date;
  last_invoked_at: Date;
}

const SEARCH_TOOL: ToolUsageFixture = {
  tool_type: "builtin",
  tool_name: "search",
  call_count: 3,
  failed_call_count: 0,
  first_invoked_at: new Date("2026-01-01T00:00:01.000Z"),
  last_invoked_at: new Date("2026-01-01T00:00:09.000Z"),
};

const LOAD_SKILL_TOOL: ToolUsageFixture = {
  tool_type: "mcp",
  tool_name: "load_skill",
  call_count: 1,
  failed_call_count: 1,
  first_invoked_at: new Date("2026-01-01T00:00:04.000Z"),
  last_invoked_at: new Date("2026-01-01T00:00:04.000Z"),
};

/** Wire withTenantDb so it satisfies BOTH call shapes the module issues:
 * `tx.select({...}).from(...).where(...)` (the execution-exists check) and
 * `tx.execute(sql...)` (the tool-call aggregation). */
function mockPostgres(
  executionRows: Array<{ id: string }>,
  usage: ToolUsageFixture[],
) {
  const tx = {
    execute: vi.fn(async () => usage),
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(executionRows),
      }),
    })),
  };
  vi.mocked(withTenantDb).mockImplementation(
    (fn) => (fn as (tx: unknown) => Promise<unknown>)(tx) as never,
  );
  return tx;
}

function baseArgs(
  overrides: Partial<ProjectExecutionToolUsageArgs> = {},
): ProjectExecutionToolUsageArgs {
  return {
    executionId: EXECUTION_ID,
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

/** Every (cypher, params) pair captured by the mocked scopedSession().run(). */
function capturedRunCalls(): Array<[string, Record<string, unknown>]> {
  return mocks.sessionRun.mock.calls as Array<
    [string, Record<string, unknown>]
  >;
}

beforeEach(() => {
  vi.mocked(withTenantDb).mockReset();
  vi.mocked(scopedSession).mockClear();
  mocks.sessionRun.mockClear();
  mocks.sessionRun.mockImplementation(async () => ({ records: [] }) as unknown);
  mocks.sessionClose.mockClear();
  mocks.sessionClose.mockResolvedValue(undefined);
});

describe("projectExecutionToolUsage — tools an execution invoked", () => {
  it("anchors the execution, then projects one :Tool and one INVOKED edge per distinct tool", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL, LOAD_SKILL_TOOL]);

    await projectExecutionToolUsage(baseArgs());

    const calls = capturedRunCalls();
    // execution anchor, tool nodes, INVOKED edges — in that order.
    expect(calls).toHaveLength(3);

    const [executionCall, toolCall, invokedCall] = calls;

    expect(executionCall![0]).toMatch(/MERGE \(e:Execution/);
    expect(executionCall![1]!.executionId).toBe(EXECUTION_ID);

    expect(toolCall![0]).toMatch(/MERGE \(t:Tool/);
    const toolParams = toolCall![1]!.tools as Array<Record<string, unknown>>;
    expect(toolParams.map((t) => t.id)).toEqual([
      "builtin:search",
      "mcp:load_skill",
    ]);
    expect(toolParams.map((t) => t.name)).toEqual(["search", "load_skill"]);

    expect(invokedCall![0]).toMatch(/MERGE \(e\)-\[i:INVOKED\]->\(t\)/);
    const invokedParams = invokedCall![1]!.tools as Array<
      Record<string, unknown>
    >;
    expect(invokedParams.map((t) => t.callCount)).toEqual([3, 1]);
    expect(invokedParams.map((t) => t.failedCallCount)).toEqual([0, 1]);

    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });

  it("scopes the tool publicId by tenant so two workspaces using the same tool name cannot collide on the graph-global constraint", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL]);
    await projectExecutionToolUsage(baseArgs());

    const toolParams = capturedRunCalls()[1]![1]!.tools as Array<
      Record<string, unknown>
    >;
    expect(toolParams[0]!.publicId).toBe(
      `${ORG_ID}:${WORKSPACE_ID}:builtin:search`,
    );

    mocks.sessionRun.mockClear();
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL]);
    await projectExecutionToolUsage(
      baseArgs({ workspaceId: "99999999-9999-9999-9999-999999999999" }),
    );
    const otherParams = capturedRunCalls()[1]![1]!.tools as Array<
      Record<string, unknown>
    >;
    expect(otherParams[0]!.publicId).not.toBe(toolParams[0]!.publicId);
  });

  it("records a load_skill call as an ordinary INVOKED edge and never as a LOADED_SKILL edge or a :Skill node", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [LOAD_SKILL_TOOL]);
    await projectExecutionToolUsage(baseArgs());

    for (const [cypher] of capturedRunCalls()) {
      expect(cypher).not.toMatch(/LOADED_SKILL/);
      expect(cypher).not.toMatch(/:Skill\b|:SkillVersion\b/);
      expect(cypher).not.toMatch(/:ToolVersion\b/);
    }
    const toolParams = capturedRunCalls()[1]![1]!.tools as Array<
      Record<string, unknown>
    >;
    expect(toolParams[0]!.id).toBe("mcp:load_skill");
  });
});

describe("projectExecutionToolUsage — idempotency", () => {
  it("issues the identical statements on a second run (safe to run repeatedly)", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL, LOAD_SKILL_TOOL]);
    await projectExecutionToolUsage(baseArgs());
    const firstCalls = capturedRunCalls().map(([cypher, params]) => [
      cypher,
      JSON.parse(JSON.stringify(params)),
    ]);

    mocks.sessionRun.mockClear();
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL, LOAD_SKILL_TOOL]);
    await projectExecutionToolUsage(baseArgs());
    const secondCalls = capturedRunCalls().map(([cypher, params]) => [
      cypher,
      JSON.parse(JSON.stringify(params)),
    ]);

    expect(secondCalls).toEqual(firstCalls);
  });

  it("every write uses MERGE on a stable key, never CREATE for the node itself", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL]);
    await projectExecutionToolUsage(baseArgs());
    for (const [cypher] of capturedRunCalls()) {
      expect(cypher).toContain("MERGE");
      // "ON CREATE SET" is MERGE's conditional branch, not a standalone
      // unconditional node/relationship creation clause — only ban the latter.
      expect(cypher).not.toMatch(/(?<!ON )CREATE \(/);
    }
    const [executionCall, toolCall] = capturedRunCalls();
    expect(executionCall![0]).toMatch(
      /MERGE \(e:Execution \{id: \$executionId, orgId: \$orgId, workspaceId: \$workspaceId\}\)/,
    );
    expect(toolCall![0]).toMatch(
      /MERGE \(t:Tool \{id: tl\.id, orgId: \$orgId, workspaceId: \$workspaceId\}\)/,
    );
  });

  it("never overwrites the citation path's execution fields — the anchor sets them ON CREATE only", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL]);
    await projectExecutionToolUsage(baseArgs());

    const executionCypher = capturedRunCalls()[0]![0];
    // The whole statement is MERGE + ON CREATE SET; an unconditional trailing
    // `SET` would clobber task_summary/started_at written by recordExecution.
    expect(executionCypher).toContain("ON CREATE SET");
    expect(executionCypher.replace(/ON CREATE SET/g, "")).not.toContain("SET");
  });
});

describe("projectExecutionToolUsage — no-tool and missing-execution cases", () => {
  it("still anchors the execution when it invoked no tools, so 'used no tools' stays distinguishable from 'never projected'", async () => {
    mockPostgres([{ id: EXECUTION_ID }], []);
    await projectExecutionToolUsage(baseArgs());

    const calls = capturedRunCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(/MERGE \(e:Execution/);
  });

  it("no-ops (never opens a graph session) when the execution id resolves to no row", async () => {
    mockPostgres([], [SEARCH_TOOL]);
    await expect(
      projectExecutionToolUsage(baseArgs()),
    ).resolves.toBeUndefined();
    expect(scopedSession).not.toHaveBeenCalled();
  });

  it("never reads tool calls for an execution that does not exist", async () => {
    const tx = mockPostgres([], [SEARCH_TOOL]);
    await projectExecutionToolUsage(baseArgs());
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

describe("projectExecutionToolUsage — SCOPE_GUARD (orgId token)", () => {
  it("every Cypher statement literally contains the `orgId` token", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL, LOAD_SKILL_TOOL]);
    await projectExecutionToolUsage(baseArgs());
    const calls = capturedRunCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const [cypher] of calls) {
      expect(cypher).toMatch(/\borgId\b/);
    }
  });
});

describe("projectExecutionToolUsage — four-store boundary", () => {
  it("never writes a spend/token/cost property to Neo4j", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL, LOAD_SKILL_TOOL]);
    await projectExecutionToolUsage(baseArgs());

    const forbidden = /cost|spend|token|usd|micros|price/i;
    for (const [cypher, params] of capturedRunCalls()) {
      expect(cypher).not.toMatch(forbidden);
      expect(JSON.stringify(params)).not.toMatch(forbidden);
    }
  });

  it("drops the token columns agent_tool_calls carries beside the ones it reads", async () => {
    // The authoritative row has input_tokens/output_tokens/latency_ms; a
    // projection that spread the row would leak them into the graph.
    const rowWithSpend = {
      ...SEARCH_TOOL,
      input_tokens: 1200,
      output_tokens: 340,
      latency_ms: 87,
    };
    mockPostgres([{ id: EXECUTION_ID }], [rowWithSpend]);
    await projectExecutionToolUsage(baseArgs());

    const toolParams = capturedRunCalls()[1]![1]!.tools as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(toolParams[0]!).sort()).toEqual([
      "callCount",
      "displayName",
      "failedCallCount",
      "firstInvokedAt",
      "id",
      "lastInvokedAt",
      "name",
      "publicId",
      "toolType",
    ]);
  });
});

describe("projectExecutionToolUsage — failure propagation", () => {
  it("propagates a Postgres read failure rather than swallowing it", async () => {
    vi.mocked(withTenantDb).mockRejectedValue(
      new Error("postgres unavailable"),
    );
    await expect(projectExecutionToolUsage(baseArgs())).rejects.toThrow(
      "postgres unavailable",
    );
  });

  it("propagates a scopedSession/Neo4j failure rather than swallowing it — callers are responsible for catching (see agent.execution.record.ts / chat.message.execution.ts)", async () => {
    mockPostgres([{ id: EXECUTION_ID }], [SEARCH_TOOL]);
    mocks.sessionRun.mockRejectedValueOnce(new Error("neo4j unavailable"));
    await expect(projectExecutionToolUsage(baseArgs())).rejects.toThrow(
      "neo4j unavailable",
    );
    // The session is still closed even on failure.
    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });
});
