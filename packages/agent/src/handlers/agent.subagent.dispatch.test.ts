import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

// Agent RBAC: the scope-denial audit path pulls emitAudit via _effective-scope;
// mock @oxagen/iam so no real DB/telemetry deps load.
const emitAuditSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@oxagen/iam", () => ({
  emitAudit: emitAuditSpy,
}));

// Track DB insert calls and Inngest send calls. The fan-out insert returns BOTH
// the internal uuid (`id`) and the external `publicId`; the handler stores `id`
// as subagent_runs.fanout_id and returns `publicId` as the dispatchId.
const insertFanoutSpy = vi.fn(async () => [{ id: "fanuuid_123", publicId: "fan_123" }]);
// Captures the rows passed to the subagent_runs batch insert so tests can
// assert the fanout_id uuid and per-child message ids are correct.
let insertedRuns: Array<Record<string, unknown>> = [];
// Captures `.set()` payloads for the post-emit UPDATEs so tests can assert the
// persisted inngest_event_id and the on-emit-failure run cleanup.
let fanoutUpdates: Array<Record<string, unknown>> = [];
let runUpdates: Array<Record<string, unknown>> = [];
// Descendant count returned by the lineage CTE (Phase 2 descendant cap).
let descendantCountResult = 0;
// send() resolves to Inngest's real shape ({ ids: [...] }); tests can override.
const inngestSendSpy = vi.fn(async () => ({ ids: ["evt_abc"] }));

const drizzleTableName = (table: unknown): string => {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "unknown";
  }
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
  ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          if (drizzleTableName(table) === "subagent_runs" && Array.isArray(vals)) {
            insertedRuns.push(...(vals as Array<Record<string, unknown>>));
          }
          return {
            returning: insertFanoutSpy,
            // The runs insert is awaited without .returning(); make it thenable.
            then: (resolve: (x: unknown) => void) => resolve(undefined),
          };
        },
      }),
      execute: () => Promise.resolve([{ descendant_count: descendantCountResult }]),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            const name = drizzleTableName(table);
            if (name === "subagent_fanouts") fanoutUpdates.push(vals);
            if (name === "subagent_runs") runUpdates.push(vals);
            return Promise.resolve(undefined);
          },
        }),
      }),
    }),

  };
});

vi.mock("../dispatch/inngest-client", () => ({
  getInngestClient: () => ({ send: inngestSendSpy }),
}));

// Deterministic registry: only these names are "registered". Unknown names are
// rejected by the dispatch hardening; agent.code.execute is high-risk so its
// timeout ceiling (300s) drives the clamp test.
vi.mock("../registry-loader", () => ({
  getOxagenRegistry: async () => ({
    listCapabilities: () => [],
    getSurfaces: () => [],
    getCapability: (name: string) =>
      (
        {
          "list_agent_tools": { name, agent: { riskLevel: "low" as const } },
          "recall_memory": { name, agent: { riskLevel: "low" as const } },
          "execute_code": { name, agent: { riskLevel: "high" as const } },
        } as Record<string, { name: string; agent: { riskLevel: "low" | "medium" | "high" } }>
      )[name],
  }),
}));

import { agentSubagentDispatchHandler } from "./agent.subagent.dispatch";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.subagent.dispatch handler", () => {
  beforeEach(() => {
    insertFanoutSpy.mockClear();
    inngestSendSpy.mockClear();
    insertedRuns = [];
    fanoutUpdates = [];
    runUpdates = [];
    descendantCountResult = 0;
    // Reset insert mock to return fanout row by default
    insertFanoutSpy.mockResolvedValue([{ id: "fanuuid_123", publicId: "fan_123" }]);
    // Reset send mock to the success shape by default.
    inngestSendSpy.mockResolvedValue({ ids: ["evt_abc"] });
  });

  it("creates a fanout record and queues an Inngest event keyed by the uuid", async () => {
    const result = await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_1",
        tasks: [
          { capabilityName: "list_agent_tools", input: {} },
          { capabilityName: "recall_memory", input: { query: "foo" } },
        ],
        maxParallel: 5,
      },
      CTX,
    );

    // Callers receive the external public_id as the dispatchId.
    expect(result.dispatchId).toBe("fan_123");
    expect(result.totalTasks).toBe(2);
    expect(result.status).toBe("pending");
    expect(inngestSendSpy).toHaveBeenCalledTimes(1);
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ name: string; data: { fanoutId: string; depth: number; maxParallel: number } }])[0];
    expect(sentEvent.name).toBe("agent/subagent.dispatch");
    // The executor matches on the uuid, NOT the public_id.
    expect(sentEvent.data.fanoutId).toBe("fanuuid_123");
    expect(sentEvent.data.depth).toBe(1);
    expect(sentEvent.data.maxParallel).toBe(5);
  });

  it("stores the fan-out uuid in fanout_id and a unique childMessageId per run", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_parent",
        tasks: [
          { capabilityName: "list_agent_tools", input: {} },
          { capabilityName: "recall_memory", input: { query: "foo" } },
        ],
        maxParallel: 5,
      },
      CTX,
    );

    expect(insertedRuns).toHaveLength(2);
    // Every run references the fan-out by its uuid — never the public_id (which
    // would fail the uuid column) and never the parentMessageId.
    for (const row of insertedRuns) {
      expect(row.fanoutId).toBe("fanuuid_123");
      expect(row.childMessageId).not.toBe("msg_parent");
    }
    // Per-child message ids must be distinct (regression: all rows previously
    // reused parentMessageId, which collides under any uniqueness constraint).
    const childIds = insertedRuns.map((r) => r.childMessageId);
    expect(new Set(childIds).size).toBe(childIds.length);
  });

  it("throws when DB insert returns no row", async () => {
    insertFanoutSpy.mockResolvedValueOnce([]);
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_2",
          tasks: [{ capabilityName: "list_agent_tools", input: {} }],
          maxParallel: 2,
        },
        CTX,
      ),
    ).rejects.toThrow("subagent_fanouts insert failed");
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it("propagates maxParallel to the Inngest event", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_3",
        tasks: [{ capabilityName: "list_agent_tools", input: {} }],
        maxParallel: 10,
      },
      CTX,
    );
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ name: string; data: { maxParallel: number } }])[0];
    expect(sentEvent.data.maxParallel).toBe(10);
  });

  it("rejects an unknown capability name before creating any rows", async () => {
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_bad",
          tasks: [{ capabilityName: "agent.bogus.nope", input: {} }],
          maxParallel: 2,
        },
        CTX,
      ),
    ).rejects.toThrow(/Unknown capability name/);
    expect(insertFanoutSpy).not.toHaveBeenCalled();
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it("clamps timeoutSeconds to the per-risk ceiling (high → 300s)", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_to",
        tasks: [{ capabilityName: "execute_code", input: {} }],
        maxParallel: 1,
        timeoutSeconds: 3600,
      },
      CTX,
    );
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ data: { timeoutSeconds: number } }])[0];
    expect(sentEvent.data.timeoutSeconds).toBe(300);
  });

  it("persists the returned Inngest event id on the fan-out (trace breadcrumb)", async () => {
    inngestSendSpy.mockResolvedValueOnce({ ids: ["evt_xyz"] });
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_evt",
        tasks: [{ capabilityName: "list_agent_tools", input: {} }],
        maxParallel: 1,
      },
      CTX,
    );
    // The fan-out row is updated with the event id so a dispatch that never
    // fired can be traced from the DB to the Inngest dashboard.
    expect(fanoutUpdates).toEqual([{ inngestEventId: "evt_xyz" }]);
    expect(runUpdates).toHaveLength(0);
  });

  it("marks child runs failed and rethrows when the Inngest emit throws", async () => {
    inngestSendSpy.mockRejectedValueOnce(new Error("INNGEST_EVENT_KEY missing"));
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_fail",
          tasks: [
            { capabilityName: "list_agent_tools", input: {} },
            { capabilityName: "recall_memory", input: { query: "x" } },
          ],
          maxParallel: 5,
        },
        CTX,
      ),
    ).rejects.toThrow(/Failed to emit subagent dispatch event: INNGEST_EVENT_KEY missing/);
    // The just-created child runs are marked failed with the cause, not left
    // orphaned as perpetually `pending`. No event id was persisted.
    expect(runUpdates).toEqual([
      {
        status: "failed",
        errorReason: "dispatch emit failed: INNGEST_EVENT_KEY missing",
        completedAt: expect.any(Date),
      },
    ]);
    expect(fanoutUpdates).toHaveLength(0);
  });

  it("rejects a dispatch that would exceed the total-descendant cap (Phase 2 §4)", async () => {
    descendantCountResult = 249;

    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_nested",
          tasks: [
            { capabilityName: "list_agent_tools", input: {} },
            { capabilityName: "recall_memory", input: {} },
          ],
          maxParallel: 5,
        },
        CTX,
      ),
    ).rejects.toThrow(/total-descendant cap of 250/);

    // Rejected BEFORE any row is created or event emitted.
    expect(insertFanoutSpy).not.toHaveBeenCalled();
    expect(insertedRuns).toHaveLength(0);
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it("allows a dispatch that lands exactly at the descendant cap", async () => {
    descendantCountResult = 248;

    const result = await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_nested",
        tasks: [
          { capabilityName: "list_agent_tools", input: {} },
          { capabilityName: "recall_memory", input: {} },
        ],
        maxParallel: 5,
      },
      CTX,
    );

    expect(result.status).toBe("pending");
    expect(inngestSendSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Agent RBAC dispatch narrowing (spec §2.7, Phase 4b) ────────────────────────

describe("agent.subagent.dispatch — role scope narrowing", () => {
  beforeEach(() => {
    insertFanoutSpy.mockClear();
    inngestSendSpy.mockClear();
    emitAuditSpy.mockClear();
    insertedRuns = [];
    fanoutUpdates = [];
    runUpdates = [];
    descendantCountResult = 0;
  });

  /**
   * CTX carrying an agentRun. Each entry of `caps` seeds the cached resolution
   * for that capability with the given outcome; `refs` sets the effective
   * agents.refs allow-list (undefined = no extra ceiling).
   */
  function agentCtx(
    caps: Record<string, "allow" | "deny">,
    refs?: string[],
  ) {
    const byCapability = new Map<string, unknown>();
    for (const [name, outcome] of Object.entries(caps)) {
      byCapability.set(name, {
        outcome,
        agentResolution: {},
        humanResolution: {},
        resourceScope: refs === undefined ? {} : { agents: { refs } },
      });
    }
    return {
      ...CTX,
      agentRun: {
        agentPrincipal: {
          id: "prn_agent",
          kind: "agent",
          orgId: CTX.orgId,
          workspaceId: CTX.workspaceId,
        },
        humanPrincipal: null,
        agentId: "agt_1",
        runId: "run_1",
        resolution: {
          byCapability,
          snapshot: { grants: [], roles: [], roleGrants: [], policies: [] },
        },
      },
    } as typeof CTX;
  }

  it("rejects a task outside the agents.refs allow-list before creating any rows", async () => {
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_1",
          tasks: [
            { capabilityName: "list_agent_tools", input: {} },
            { capabilityName: "recall_memory", input: {} },
          ],
        },
        agentCtx(
          { list_agent_tools: "allow", recall_memory: "allow" },
          ["list_agent_tools"], // recall_memory not dispatchable
        ),
      ),
    ).rejects.toThrow(/role scope does not permit.*recall_memory/);
    expect(insertFanoutSpy).not.toHaveBeenCalled();
    expect(inngestSendSpy).not.toHaveBeenCalled();
    expect(emitAuditSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a task whose effective capability outcome is deny (no laundering)", async () => {
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_1",
          tasks: [{ capabilityName: "execute_code", input: {} }],
        },
        agentCtx({ execute_code: "deny" }),
      ),
    ).rejects.toThrow(/role scope does not permit.*execute_code/);
    expect(insertFanoutSpy).not.toHaveBeenCalled();
  });

  it("dispatches normally when every task is in refs and resolves allow", async () => {
    const result = await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_1",
        tasks: [{ capabilityName: "list_agent_tools", input: {} }],
      },
      agentCtx({ list_agent_tools: "allow" }, ["list_agent_tools"]),
    );
    expect(result.status).toBe("pending");
    expect(insertFanoutSpy).toHaveBeenCalledTimes(1);
    expect(emitAuditSpy).not.toHaveBeenCalled();
  });
});
