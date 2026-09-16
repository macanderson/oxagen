/**
 * The assistant run recorder: what it resolves before a turn, what it writes
 * during one, and how it seals. The ledger store is a fake that keeps the
 * rows it was given; the identity reads run against a tx double routed by
 * table, with the WHERE rendered so the key each read pins is asserted, not
 * assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type {
  AppendAttemptBatchInput,
  CreateAttemptInput,
  CreateRunInput,
  RunStore,
  SealAttemptInput,
} from "@oxagen/run-ledger";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/iam", () => ({
  createAgentRunAuthorizationSnapshot: mocks.snapshot,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

import {
  ASSISTANT_ENGINE,
  ASSISTANT_PRINCIPAL_NAME,
  ASSISTANT_RETENTION_POLICY,
  AssistantRunNotRecordedError,
  openAssistantRun,
  resolveAssistantRunIdentity,
} from "./assistant-run";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

// ── tx double ─────────────────────────────────────────────────────────────────

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const USER = "user-1";
const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
};

interface World {
  agent: { principalId: string | null; activeVersionId: string | null } | null;
  operatorPrincipalId: string | null;
  retention: { id: string; publicId: string; digest: string } | null;
  /** Whether the principal link UPDATE matches (false: another turn won). */
  linkWins: boolean;
  linkedByOther: string | null;
}

interface Captured {
  selects: Array<{ table: unknown; where: string }>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
  deletes: Array<{ table: unknown; where: string }>;
}

function makeTx(world: World, captured: Captured) {
  const rowsFor = (table: unknown, where: SQL | null): unknown[] => {
    const sql = where ? render(where).sql : "";
    if (table === schema.agents) {
      // The identity read pins the slug; the re-read after a lost link race
      // pins the id alone.
      if (!/"slug" = \$/.test(sql))
        return [{ principalId: world.linkedByOther }];
      return world.agent ? [{ id: AGENT.id, ...world.agent }] : [];
    }
    if (table === schema.agentVersions)
      return [{ id: AGENT.versionId, config: { graph: { mode: "read" } } }];
    if (table === schema.principals)
      return world.operatorPrincipalId
        ? [{ id: world.operatorPrincipalId }]
        : [];
    if (table === schema.retentionPolicyVersions)
      return world.retention ? [world.retention] : [];
    throw new Error("unexpected table");
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        let lastWhere: SQL | null = null;
        const chain = {
          where: (cond: SQL) => {
            lastWhere = cond;
            captured.selects.push({ table, where: render(cond).sql });
            return chain;
          },
          orderBy: () => chain,
          limit: () => Promise.resolve(rowsFor(table, lastWhere)),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push({ table, values });
        const returning = () =>
          Promise.resolve(
            table === schema.principals ? [{ id: "svc-principal" }] : [],
          );
        return {
          returning,
          onConflictDoNothing: () => {
            if (table === schema.retentionPolicyVersions) {
              world.retention = {
                id: "rpv-row",
                publicId: "rpv_0123456789abcdef0123",
                digest: values.policyDigest as string,
              };
            }
            return Promise.resolve();
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        captured.updates.push({ table, set: values });
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(
                world.linkWins ? [{ principalId: values.principalId }] : [],
              ),
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (cond: SQL) => {
        captured.deletes.push({ table, where: render(cond).sql });
        return Promise.resolve();
      },
    }),
  };
}

function setup(overrides: Partial<World> = {}): {
  world: World;
  captured: Captured;
} {
  const world: World = {
    agent: { principalId: "asst-principal", activeVersionId: AGENT.versionId },
    operatorPrincipalId: "human-principal",
    retention: {
      id: "rpv-row",
      publicId: "rpv_0123456789abcdef0123",
      digest: "sha256:" + "a".repeat(64),
    },
    linkWins: true,
    linkedByOther: null,
    ...overrides,
  };
  const captured: Captured = {
    selects: [],
    inserts: [],
    updates: [],
    deletes: [],
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(world, captured))),
  );
  return { world, captured };
}

// ── fake ledger store ─────────────────────────────────────────────────────────

/**
 * The real store's density rule (`planAttemptBatch`, `sealAttempt`): an event
 * whose seq is not one past the last durable event is refused.
 */
function fakeStore(options: { failAppendCall?: number } = {}) {
  const runs: CreateRunInput[] = [];
  const attempts: CreateAttemptInput[] = [];
  const batches: AppendAttemptBatchInput[] = [];
  const seals: SealAttemptInput[] = [];
  let lastDurable = 0;
  let appendCalls = 0;
  const assertDense = (seq: number): void => {
    if (seq !== lastDurable + 1) {
      throw new Error(`sequence gap: ${seq} after ${lastDurable}`);
    }
  };
  const store: RunStore = {
    createRun: async (input) => {
      runs.push(input);
      return {
        runId: "run-uuid",
        publicId: "arun_0123456789abcdef012345",
        specDigest: "sha256:" + "d".repeat(64),
      };
    },
    createAttempt: async (input) => {
      attempts.push(input);
      return {
        attemptId: "attempt-uuid",
        attemptPublicId: "arat_0123456789abcdef0123",
        runId: input.runId,
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        attemptNumber: 1,
        maxAttempts: 1,
        engine: input.engine,
        resumedFrom: null,
        forkedFromRunSeq: null,
      };
    },
    appendAttemptBatch: async (input) => {
      const seq = input.events[0]!.attemptSeq;
      appendCalls += 1;
      if (appendCalls === options.failAppendCall)
        throw new Error("ledger is read-only");
      assertDense(seq);
      lastDurable = seq;
      batches.push(input);
      return {
        events: [],
        lastAttemptSeq: seq,
        lastRunSeq: String(seq),
        eventCount: seq,
        eventStreamDigest: "sha256:" + "e".repeat(64),
        finalEventDigest: null,
      };
    },
    sealAttempt: async (input) => {
      assertDense(input.terminalEvent!.attemptSeq);
      seals.push(input);
      return {} as never;
    },
    getRunByPublicId: async () => null,
    listRunAttempts: async () => [],
    readAttemptState: async () => ({}) as never,
    readAttemptEventsSince: async () => [],
    compactSealedAttempts: async () => 0,
    setRunSummary: async () => false,
    getFinalizationHandle: async () => null,
  };
  return { store, runs, attempts, batches, seals };
}

const SNAPSHOT = {
  snapshotId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
  snapshotDigest: "sha256:" + "1".repeat(64),
  grantCeilingDigest: "sha256:" + "2".repeat(64),
  denyGenerationAtAdmission: { org: 3, workspace: 4 },
  resolvedAt: "2026-09-14T10:00:00.000Z",
};

const UUIDS = {
  human: "33333333-3333-4333-8333-333333333333",
  service: "44444444-4444-4444-8444-444444444444",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue(SNAPSHOT);
});

// ── identity ──────────────────────────────────────────────────────────────────

describe("resolveAssistantRunIdentity", () => {
  it("binds the managed agent, its service principal and the asking person's human principal", async () => {
    const { captured } = setup();
    const identity = await mocks.withTenantDb((tx: never) =>
      resolveAssistantRunIdentity(tx, SCOPE, USER),
    );
    expect(identity).toMatchObject({
      agentId: AGENT.id,
      agentPrincipalId: "asst-principal",
      agentVersionId: AGENT.versionId,
      initiatingPrincipalId: "human-principal",
      retention: { rowId: "rpv-row", publicId: "rpv_0123456789abcdef0123" },
    });
    expect(identity.agentVersionChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The agent read pins the workspace and the managed slug; the operator
    // read pins the org, the user and kind = human.
    const agentRead = captured.selects.find((s) => s.table === schema.agents)!;
    expect(agentRead.where).toMatch(/"workspace_id" = \$/);
    expect(agentRead.where).toMatch(/"slug" = \$/);
    const operatorRead = captured.selects.find(
      (s) => s.table === schema.principals,
    )!;
    expect(operatorRead.where).toMatch(/"parent_user_id" = \$/);
    expect(operatorRead.where).toMatch(/"kind" = \$/);
    expect(captured.inserts).toHaveLength(0);
  });

  it("provisions the oxagen.assistant service principal once and links it to the agent", async () => {
    const { captured } = setup({
      agent: { principalId: null, activeVersionId: AGENT.versionId },
    });
    const identity = await mocks.withTenantDb((tx: never) =>
      resolveAssistantRunIdentity(tx, SCOPE, USER),
    );
    expect(identity.agentPrincipalId).toBe("svc-principal");
    expect(captured.inserts).toEqual([
      {
        table: schema.principals,
        values: expect.objectContaining({
          kind: "service",
          displayName: ASSISTANT_PRINCIPAL_NAME,
          orgId: SCOPE.orgId,
          workspaceId: SCOPE.workspaceId,
          parentUserId: null,
        }),
      },
    ]);
    expect(captured.updates).toEqual([
      { table: schema.agents, set: { principalId: "svc-principal" } },
    ]);
    expect(captured.deletes).toHaveLength(0);
  });

  it("yields to a concurrent first turn that linked its principal first", async () => {
    const { captured } = setup({
      agent: { principalId: null, activeVersionId: AGENT.versionId },
      linkWins: false,
      linkedByOther: "other-principal",
    });
    const identity = await mocks.withTenantDb((tx: never) =>
      resolveAssistantRunIdentity(tx, SCOPE, USER),
    );
    expect(identity.agentPrincipalId).toBe("other-principal");
    expect(captured.deletes).toEqual([
      { table: schema.principals, where: expect.stringMatching(/"id" = \$/) },
    ]);
  });

  it("pins a digest-only retention policy when the workspace has none", async () => {
    const { captured } = setup({ retention: null });
    const identity = await mocks.withTenantDb((tx: never) =>
      resolveAssistantRunIdentity(tx, SCOPE, USER),
    );
    const insert = captured.inserts.find(
      (i) => i.table === schema.retentionPolicyVersions,
    )!;
    expect(insert.values).toMatchObject({
      version: 1,
      mode: ASSISTANT_RETENTION_POLICY.mode,
      retainedContentClasses: [],
      ttlDays: ASSISTANT_RETENTION_POLICY.ttl_days,
      createdByUserId: USER,
    });
    expect(identity.retention.digest).toBe(insert.values.policyDigest);
  });

  it("refuses when the workspace has no published assistant agent", async () => {
    setup({ agent: null });
    await expect(
      mocks.withTenantDb((tx: never) =>
        resolveAssistantRunIdentity(tx, SCOPE, USER),
      ),
    ).rejects.toMatchObject({
      name: "AssistantRunNotRecordedError",
      reason: "assistant_agent_missing",
    });
  });

  it("refuses when the asking user has no human principal", async () => {
    setup({ operatorPrincipalId: null });
    await expect(
      mocks.withTenantDb((tx: never) =>
        resolveAssistantRunIdentity(tx, SCOPE, USER),
      ),
    ).rejects.toMatchObject({
      name: "AssistantRunNotRecordedError",
      reason: "operator_principal_missing",
    });
  });
});

// ── the run ───────────────────────────────────────────────────────────────────

function setupRun(overrides: Partial<World> = {}) {
  return setup({
    agent: { principalId: UUIDS.service, activeVersionId: AGENT.versionId },
    operatorPrincipalId: UUIDS.human,
    ...overrides,
  });
}

describe("openAssistantRun", () => {
  it("admits the turn as a run under the assistant identity and writes the admission receipt", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "  explain run arun_1  ",
      maxSteps: 12,
      store: ledger.store,
      now: () => new Date("2026-09-14T10:00:01.000Z"),
    });
    expect(recorder.runPublicId).toBe("arun_0123456789abcdef012345");
    expect(mocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        ...SCOPE,
        initiatingPrincipalId: UUIDS.human,
        agentPrincipalId: UUIDS.service,
      }),
    );
    expect(ledger.runs[0]).toMatchObject({
      ...SCOPE,
      surface: "chat",
      repositoryBindingRowId: null,
      spec: expect.objectContaining({
        run_kind: "general",
        goal: "explain run arun_1",
        engine_policy: expect.objectContaining({
          requested_engine: "stella",
          allowed_engine_versions: [ASSISTANT_ENGINE.version],
          max_steps: 12,
          max_attempts: 1,
        }),
        actor_binding: expect.objectContaining({
          initiating_principal_id: UUIDS.human,
          agent_principal_id: UUIDS.service,
        }),
      }),
    });
    expect(ledger.attempts[0]).toMatchObject({
      runId: "run-uuid",
      producerId: ASSISTANT_PRINCIPAL_NAME,
      engine: ASSISTANT_ENGINE,
    });
    expect(ledger.batches).toHaveLength(1);
    expect(ledger.batches[0]!.events[0]).toMatchObject({
      attemptSeq: 1,
      eventType: "admission.run_admitted",
      observedAt: "2026-09-14T10:00:01.000Z",
      payload: expect.objectContaining({
        attempt_number: 1,
        engine_name: "stella",
        engine_build_digest: ASSISTANT_ENGINE.buildDigest,
      }),
    });
  });

  it("records receipts with a dense attempt seq and the engine seq, and seals with verdict waived", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 4,
      store: ledger.store,
    });
    await recorder.modelCall({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      outcome: "completed",
      usage: {
        reported: true,
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 2,
      },
    });
    await recorder.toolCall({
      seq: 3,
      requestId: "tool-1-0",
      toolName: "search_tools",
      outcome: "completed",
      input: { query: "grant" },
      output: { rows: [] },
      durationMs: 12.6,
    });
    await recorder.toolCall({
      seq: 5,
      requestId: "tool-1-1",
      toolName: "set_budget",
      outcome: "denied",
      input: { usd: 5 },
      error: "approval denied",
      durationMs: 3,
    });
    await recorder.seal({ status: "completed", text: "done" });

    expect(
      ledger.batches.map((b) => [
        b.events[0]!.attemptSeq,
        b.events[0]!.eventType,
      ]),
    ).toEqual([
      [1, "admission.run_admitted"],
      [2, "model.engine_call_completed"],
      [3, "tool.engine_call_completed"],
      [4, "tool.engine_call_completed"],
    ]);
    expect(ledger.batches[1]!.events[0]!.payload).toEqual({
      engine_seq: 1,
      model_call_id: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      outcome: "completed",
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 2,
    });
    expect(ledger.batches[2]!.events[0]!.payload).toMatchObject({
      engine_seq: 3,
      tool_name: "search_tools",
      outcome: "completed",
      input_digest: expect.stringMatching(/^sha256:/),
      output_digest: expect.stringMatching(/^sha256:/),
      duration_ms: 13,
    });
    expect(ledger.batches[3]!.events[0]!.payload).toMatchObject({
      engine_seq: 5,
      outcome: "denied",
      error_digest: expect.stringMatching(/^sha256:/),
    });
    expect(ledger.seals).toEqual([
      expect.objectContaining({
        attemptId: "attempt-uuid",
        terminalStatus: "completed",
        sealerId: ASSISTANT_PRINCIPAL_NAME,
        result: { verdict: "waived" },
        terminalEvent: expect.objectContaining({
          attemptSeq: 5,
          eventType: "terminal.attempt_terminated",
          payload: expect.objectContaining({ terminal_status: "completed" }),
        }),
      }),
    ]);
  });

  it("seals an aborted turn as cancelled and a failed one as failed", async () => {
    setupRun();
    const ledger = fakeStore();
    const failedLedger = fakeStore();
    const aborted = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "a",
      maxSteps: 1,
      store: ledger.store,
    });
    await aborted.seal({ status: "aborted", reason: "budget" });
    const failed = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "b",
      maxSteps: 1,
      store: failedLedger.store,
    });
    await failed.seal({ status: "failed", error: "engine unavailable" });
    const seals = [...ledger.seals, ...failedLedger.seals];
    expect(seals.map((s) => [s.terminalStatus, s.error])).toEqual([
      ["cancelled", "budget"],
      ["failed", "engine unavailable"],
    ]);
    expect(
      seals.map(
        (s) =>
          (s.terminalEvent!.payload as { reason_code: string }).reason_code,
      ),
    ).toEqual(["engine_aborted", "turn_failed"]);
  });

  it("rejects the receipt whose append failed, gives its seq to the next event, and seals densely", async () => {
    setupRun();
    const ledger = fakeStore({ failAppendCall: 2 });
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "a",
      maxSteps: 1,
      store: ledger.store,
    });
    await expect(
      recorder.modelCall({
        seq: 1,
        requestId: "r",
        role: "worker",
        provider: "p",
        model: "m",
        outcome: "completed",
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantRunNotRecordedError &&
        e.reason === "ledger_refused" &&
        e.message.includes("ledger is read-only"),
    );
    // The admission receipt holds seq 1; the failed receipt's seq 2 is not
    // spent, so the next receipt and then the seal land densely.
    await recorder.toolCall({
      seq: 2,
      requestId: "t",
      toolName: "list_runs",
      outcome: "completed",
      input: {},
      output: {},
      durationMs: 1,
    });
    await recorder.seal({ status: "aborted", reason: "unrecorded step" });
    expect(ledger.batches.map((b) => b.events[0]!.attemptSeq)).toEqual([1, 2]);
    expect(ledger.seals[0]).toMatchObject({
      terminalStatus: "cancelled",
      terminalEvent: expect.objectContaining({ attemptSeq: 3 }),
    });
  });

  it("refuses before the engine when the ledger will not admit the run", async () => {
    setupRun();
    const ledger = fakeStore();
    ledger.store.createRun = async () => {
      throw new Error("spec identity mismatch");
    };
    await expect(
      openAssistantRun({
        ...SCOPE,
        userId: USER,
        surface: "chat",
        instruction: "a",
        maxSteps: 1,
        store: ledger.store,
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantRunNotRecordedError &&
        e.reason === "ledger_refused",
    );
    expect(ledger.attempts).toHaveLength(0);
  });

  // The execution record the turn writes afterwards needs the agent the run was
  // attributed to and the payloads the ledger only kept digests of.
  it("carries the run's agent and every receipt for the turn's execution record", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "hi",
      maxSteps: 4,
      store: ledger.store,
    });
    expect(recorder.agentId).toBe(AGENT.id);
    expect(recorder.agentVersionId).toBe(AGENT.versionId);
    expect(recorder.receipts).toEqual([]);

    await recorder.modelCall({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      outcome: "completed",
    });
    await recorder.toolCall({
      seq: 2,
      requestId: "tool-2-0",
      toolName: "recall_memory",
      outcome: "completed",
      input: { query: "runs" },
      output: { hits: 2 },
      durationMs: 12,
    });
    expect(recorder.receipts.map((r) => [r.kind, r.seq])).toEqual([
      ["model", 1],
      ["tool", 2],
    ]);
    // The payloads survive, which is the whole reason for keeping them: the
    // ledger event carries `input_digest`, not the input.
    expect(recorder.receipts[1]).toMatchObject({
      kind: "tool",
      toolName: "recall_memory",
      input: { query: "runs" },
      output: { hits: 2 },
    });
  });

  // seal() reads the chain once and then takes a seq. An append that arrived
  // during that await would chain onto the older value and could take a seq at
  // or past the terminal event's, which the store refuses. No caller reaches it
  // today; the latch makes that falsifiable instead of a comment.
  it("refuses an append after the attempt is sealed (negative)", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "hi",
      maxSteps: 4,
      store: ledger.store,
    });
    await recorder.seal({ status: "completed", text: "done" });
    await expect(
      recorder.modelCall({
        seq: 9,
        requestId: "late",
        role: "worker",
        provider: "oxagen",
        model: "m",
        outcome: "completed",
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantRunNotRecordedError &&
        e.reason === "ledger_refused",
    );
  });

  it("carries an identity refusal through unchanged", async () => {
    setupRun({ operatorPrincipalId: null });
    await expect(
      openAssistantRun({
        ...SCOPE,
        userId: USER,
        surface: "chat",
        instruction: "a",
        maxSteps: 1,
        store: fakeStore().store,
      }),
    ).rejects.toMatchObject({ reason: "operator_principal_missing" });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
