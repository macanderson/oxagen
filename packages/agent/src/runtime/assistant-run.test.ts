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
import { digestJcs } from "@oxagen/run-evidence";
import {
  digestOfCanonicalJson,
  RETENTION_CONTENT_CLASSES,
  validateInlineEventPayload,
} from "@oxagen/run-ledger";
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
  killSwitches: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
// Only the constructor: every other export is the real one, and every other
// test in this file injects its own store, so nothing else here goes through
// it. The capture is what proves the default store carries both seams.
const storeOptions: Array<Record<string, unknown>> = [];
vi.mock("@oxagen/run-ledger", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/run-ledger")>();
  return {
    ...real,
    createPostgresRunStore: (options: Record<string, unknown> = {}) => {
      storeOptions.push(options);
      return real.createPostgresRunStore(options);
    },
  };
});

vi.mock("@oxagen/iam", async () => {
  const scopes = await vi.importActual<
    typeof import("@oxagen/iam/resource-scope")
  >("@oxagen/iam/resource-scope");
  return {
    createAgentRunAuthorizationSnapshot: mocks.snapshot,
    readActiveKillSwitches: mocks.killSwitches,
    resourceScopeDigestOf: scopes.resourceScopeDigestOf,
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

import {
  ASSISTANT_CONTEXT_PROVIDERS,
  ASSISTANT_ENGINE,
  ASSISTANT_MAX_BODY_BYTES,
  ASSISTANT_MAX_CONTEXT_FRAMES,
  ASSISTANT_MAX_CONTEXT_TOKENS,
  ASSISTANT_PRINCIPAL_NAME,
  ASSISTANT_RETENTION_POLICY,
  assistantRunStore,
  AssistantRunNotRecordedError,
  HISTORY_SUMMARY_PROVIDER,
  openAssistantRun,
  readAssistantAgentState,
  resolveAssistantRunIdentity,
} from "./assistant-run";
import { assembleAssistantSteering } from "./assistant-steering";
import { resourceScopeDigestOf } from "@oxagen/iam";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

// ── tx double ─────────────────────────────────────────────────────────────────

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const USER = "user-1";
const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  publicId: "agt_assistant",
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
      return world.agent
        ? [{ id: AGENT.id, publicId: AGENT.publicId, ...world.agent }]
        : [];
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
function fakeStore(
  options: { failAppendCall?: number; failCreateAttempt?: boolean } = {},
) {
  const finishedRuns: Array<{
    runId: string;
    status: string;
    error: string | null;
  }> = [];
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
    finishRun: async (runId, status, error) => {
      finishedRuns.push({ runId, status, error });
      return true;
    },
    createRun: async (input) => {
      runs.push(input);
      return {
        runId: "run-uuid",
        publicId: "arun_0123456789abcdef012345",
        specDigest: "sha256:" + "d".repeat(64),
      };
    },
    createAttempt: async (input) => {
      if (options.failCreateAttempt) throw new Error("attempt insert failed");
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
    abandonRun: async () => null,
    getRunByPublicId: async () => null,
    listRunAttempts: async () => [],
    readAttemptState: async () => ({}) as never,
    readAttemptEventsSince: async () => [],
    readToolCallsForRuns: async () => new Map(),
    compactSealedAttempts: async () => 0,
    setRunSummary: async () => false,
    getFinalizationHandle: async () => null,
  };
  return { store, runs, attempts, batches, seals, finishedRuns };
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

// ── the assistant agent and its kill switch ───────────────────────────────────

describe("readAssistantAgentState", () => {
  /** An active switch as `readActiveKillSwitches` returns it. */
  const switchOn = (kind: string, id: string) => ({
    publicId: `edn_${kind}`,
    targetKind: kind,
    targetId: id,
    resourceScopeDigest: resourceScopeDigestOf({ kind, id }),
    reason: `${kind} incident`,
  });

  it("names the assistant agent by its public id and principal, and is not stopped with no switch on", async () => {
    const { captured } = setup();
    const state = await mocks.withTenantDb((tx: never) =>
      readAssistantAgentState(tx, SCOPE),
    );
    expect(state).toEqual({
      agentId: AGENT.publicId,
      principalId: "asst-principal",
      stoppedBy: null,
    });
    const agentRead = captured.selects.find((s) => s.table === schema.agents)!;
    expect(agentRead.where).toMatch(/"slug" = \$/);
    expect(agentRead.where).toMatch(/"workspace_id" = \$/);
    expect(mocks.killSwitches).toHaveBeenCalledWith(expect.anything(), SCOPE);
  });

  it("is stopped by an agent switch on the assistant, and by nothing else", async () => {
    setup();
    mocks.killSwitches.mockResolvedValueOnce([
      switchOn("agent", "agt_someone_else"),
      switchOn("workspace", SCOPE.workspaceId),
      switchOn("agent", AGENT.publicId),
    ]);
    const stopped = await mocks.withTenantDb((tx: never) =>
      readAssistantAgentState(tx, SCOPE),
    );
    expect(stopped.stoppedBy).toEqual({
      publicId: "edn_agent",
      reason: "agent incident",
    });

    mocks.killSwitches.mockResolvedValueOnce([
      switchOn("agent", "agt_someone_else"),
      switchOn("workspace", SCOPE.workspaceId),
    ]);
    const open = await mocks.withTenantDb((tx: never) =>
      readAssistantAgentState(tx, SCOPE),
    );
    expect(open.stoppedBy).toBeNull();
  });

  it("answers null for a workspace with no assistant agent, and reads no switch (negative)", async () => {
    setup({ agent: null });
    const state = await mocks.withTenantDb((tx: never) =>
      readAssistantAgentState(tx, SCOPE),
    );
    expect(state).toBeNull();
    expect(mocks.killSwitches).not.toHaveBeenCalled();
  });
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

  it("pins the workspace's documented retain-all default when it has none", async () => {
    // `retention_policy_versions` is read workspace-latest, so the row the
    // first assistant turn writes becomes the whole workspace's policy. It
    // used to write `digest_only`/30d, which silently opted every subsequent
    // Tacho run down to `inspect` with its bodies refused. The literal values
    // are asserted rather than echoed from ASSISTANT_RETENTION_POLICY: the
    // previous version of this test read `mode` and `ttl_days` off the
    // constant, so it would have passed just as green with the unsafe values
    // in place and proved nothing about what the workspace keeps.
    const { captured } = setup({ retention: null });
    const identity = await mocks.withTenantDb((tx: never) =>
      resolveAssistantRunIdentity(tx, SCOPE, USER),
    );
    const insert = captured.inserts.find(
      (i) => i.table === schema.retentionPolicyVersions,
    )!;
    expect(insert.values).toMatchObject({
      version: 1,
      mode: "content_exact",
      ttlDays: 2555,
      createdById: USER,
    });
    // Every content class, so `readWorkspaceRetention` answers exactly what a
    // workspace with no row answers.
    expect(insert.values.retainedContentClasses).toEqual([
      ...RETENTION_CONTENT_CLASSES,
    ]);
    expect(ASSISTANT_RETENTION_POLICY.mode).not.toBe("digest_only");
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
      toolAllowlist: ["recall_memory", "search_tools"],
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

  // ADR-076: the seal attests to the spec's digest, so the spec has to be what
  // the turn ran under. It pinned sandbox_required: true, an empty provider
  // allowlist, max_frames 0, max_tokens 0 and an empty tool allowlist while
  // running unsandboxed, framing a recalled memory, and calling the governed
  // catalogue — a run whose own evidence contradicted it.
  it("pins the policies the turn actually runs under", async () => {
    setupRun();
    const ledger = fakeStore();
    await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "hi",
      maxSteps: 12,
      toolAllowlist: ["set_budget", "recall_memory", "set_budget"],
      store: ledger.store,
    });
    const spec = ledger.runs[0]!.spec as {
      workspace_policy: { sandbox_required: boolean };
      context_policy: {
        provider_allowlist: string[];
        max_frames: number;
        max_tokens: number;
      };
      tool_policy: { allowlist: string[]; risk_ceiling: string };
    };
    // The turn runs in this process through kernel.invoke(); there is no
    // sandbox, so the spec does not claim one.
    expect(spec.workspace_policy.sandbox_required).toBe(false);
    expect(spec.context_policy).toMatchObject({
      provider_allowlist: [...ASSISTANT_CONTEXT_PROVIDERS],
      max_frames: ASSISTANT_MAX_CONTEXT_FRAMES,
      max_tokens: ASSISTANT_MAX_CONTEXT_TOKENS,
    });
    expect(spec.context_policy.max_frames).toBeGreaterThan(0);
    // Deduplicated and ordered, so two turns holding the same set digest the
    // same regardless of the order materializeTools returned them in.
    expect(spec.tool_policy.allowlist).toEqual(["recall_memory", "set_budget"]);
    expect(spec.tool_policy.risk_ceiling).toBe("high");
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
      toolAllowlist: ["recall_memory", "search_tools"],
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

  it("records a parked call as parked, naming its approval, in a receipt the ledger accepts", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "make a workspace",
      maxSteps: 4,
      toolAllowlist: ["create_workspace"],
      store: ledger.store,
    });
    await recorder.toolCall({
      seq: 3,
      requestId: "tool-1-0",
      toolName: "create_workspace",
      outcome: "parked",
      approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
      input: { name: "ops" },
      error: "refused: create_workspace is waiting for approval",
      durationMs: 4,
    });
    // A denied call names no approval even when handed one: only a park
    // waits on a person.
    await recorder.toolCall({
      seq: 5,
      requestId: "tool-1-1",
      toolName: "create_workspace",
      outcome: "denied",
      approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
      input: { name: "ops" },
      error: "approval denied",
      durationMs: 2,
    });
    const parked = ledger.batches[1]!.events[0]!;
    const denied = ledger.batches[2]!.events[0]!;
    expect(parked.eventType).toBe("tool.engine_call_completed");
    expect(parked.payload).toMatchObject({
      outcome: "parked",
      approval_public_id: "apr_0a1b2c3d4e5f6g7h8j9k0m",
      error_digest: expect.stringMatching(/^sha256:/),
    });
    expect(denied.payload).toMatchObject({ outcome: "denied" });
    expect(denied.payload).not.toHaveProperty("approval_public_id");
    // The real registry, which the Postgres store runs before any SQL.
    for (const event of [parked, denied])
      expect(() =>
        validateInlineEventPayload(event.eventType, event.payload),
      ).not.toThrow();
    expect(
      recorder.receipts.map((r) => r.kind === "tool" && r.outcome),
    ).toEqual(["parked", "denied"]);
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
      toolAllowlist: ["recall_memory", "search_tools"],
      store: ledger.store,
    });
    await aborted.seal({ status: "aborted", reason: "budget" });
    const failed = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "b",
      maxSteps: 1,
      toolAllowlist: ["recall_memory", "search_tools"],
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

  it("admits a turn whose belt holds an external MCP tool", async () => {
    // The belt names an MCP tool `mcp.<server uuid>.<tool>` and every UUID
    // has hyphens, which the run spec's capability form does not allow. So
    // enabling any MCP server — the ordinary documented thing — made every
    // assistant turn fail here with `assistant_run_not_recorded`, before the
    // engine was ever contacted. The allowlist now carries the name through
    // unchanged, so the spec records exactly what the turn was permitted.
    setupRun();
    const ledger = fakeStore();
    const mcpTool =
      "mcp.9f3e1a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b.list_pull_requests";
    await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "a",
      maxSteps: 1,
      toolAllowlist: ["recall_memory", mcpTool, "file-mcp.my-server.read_file"],
      store: ledger.store,
    });
    expect(ledger.runs[0]!.spec.tool_policy.allowlist).toContain(mcpTool);
  });

  it("seals the attempt when the admission event cannot be appended", async () => {
    // createRun and createAttempt succeeded, so the rows exist, and the caller
    // never receives a recorder it could seal: without this the run and its
    // attempt stay open for ever on a transient ledger failure during
    // admission itself.
    setupRun();
    const ledger = fakeStore({ failAppendCall: 1 });
    await expect(
      openAssistantRun({
        ...SCOPE,
        userId: USER,
        surface: "chat",
        instruction: "a",
        maxSteps: 1,
        toolAllowlist: ["recall_memory"],
        store: ledger.store,
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantRunNotRecordedError &&
        e.reason === "ledger_refused",
    );
    expect(ledger.seals).toHaveLength(1);
    expect(ledger.seals[0]).toMatchObject({ terminalStatus: "failed" });
    expect(ledger.finishedRuns).toEqual([]);
  });

  it("finishes the run as failed when no attempt could be created", async () => {
    // Nothing to seal in this one — sealAttempt cannot reach a run with no
    // attempt — so the run itself is driven terminal.
    setupRun();
    const ledger = fakeStore({ failCreateAttempt: true });
    await expect(
      openAssistantRun({
        ...SCOPE,
        userId: USER,
        surface: "chat",
        instruction: "a",
        maxSteps: 1,
        toolAllowlist: ["recall_memory"],
        store: ledger.store,
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof AssistantRunNotRecordedError &&
        e.reason === "ledger_refused",
    );
    expect(ledger.seals).toEqual([]);
    expect(ledger.finishedRuns).toEqual([
      { runId: "run-uuid", status: "failed", error: "attempt insert failed" },
    ]);
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
      toolAllowlist: ["recall_memory", "search_tools"],
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
        toolAllowlist: ["recall_memory", "search_tools"],
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
      toolAllowlist: ["recall_memory", "search_tools"],
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

  it("appends the model intention as its own event and never counts it as a call", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "hi",
      maxSteps: 4,
      toolAllowlist: ["recall_memory"],
      store: ledger.store,
    });

    await recorder.modelCallStarted({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
    });
    await recorder.modelCall({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4.6",
      outcome: "completed",
    });

    // Two events, the intention first, both joinable on the frame and the
    // request id — that join is the whole point, and it is also what shows a
    // gateway substitution: the intention names the configured model, the
    // receipt names the one the provider served.
    expect(
      ledger.batches.map((b) => [
        b.events[0]!.attemptSeq,
        b.events[0]!.eventType,
      ]),
    ).toEqual([
      [1, "admission.run_admitted"],
      [2, "model.engine_call_started"],
      [3, "model.engine_call_completed"],
    ]);
    expect(ledger.batches[1]!.events[0]!.payload).toEqual({
      engine_seq: 1,
      model_call_id: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
    });

    // The intention is NOT a receipt. `stepsFromReceipts` turns that array
    // into the turn's agent_executions steps, so counting it there would
    // report every completion of the turn twice.
    expect(recorder.receipts.map((r) => [r.kind, r.seq])).toEqual([
      ["model", 1],
    ]);
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
      toolAllowlist: ["recall_memory", "search_tools"],
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
        toolAllowlist: ["recall_memory", "search_tools"],
        store: fakeStore().store,
      }),
    ).rejects.toMatchObject({ reason: "operator_principal_missing" });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});

// ── frame bodies ──────────────────────────────────────────────────────────────

describe("the recorder hands the ledger the content its frames are about", () => {
  const decode = (body: { bytes: Uint8Array } | undefined) =>
    body === undefined ? undefined : new TextDecoder().decode(body.bytes);
  const bodyOf = (
    batches: ReadonlyArray<{ events: readonly { eventType: string }[] }>,
    eventType: string,
  ) =>
    (
      batches.find((b) => b.events[0]!.eventType === eventType) as
        | {
            events: readonly {
              body?: { contentType: string; bytes: Uint8Array };
            }[];
          }
        | undefined
    )?.events[0]!.body;

  async function record(): Promise<ReturnType<typeof fakeStore>> {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 4,
      toolAllowlist: ["recall_memory", "search_tools"],
      store: ledger.store,
    });
    await recorder.modelCallStarted({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      request: { messages: [{ role: "user", content: "what did we spend?" }] },
    });
    await recorder.modelCall({
      seq: 1,
      requestId: "prov-1-0",
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      outcome: "completed",
      response: { text: "four dollars", model: "anthropic/claude-sonnet-4" },
    });
    await recorder.toolCallStarted({
      seq: 3,
      requestId: "tool-1-0",
      toolName: "search_tools",
      input: { query: "grant" },
    });
    await recorder.toolCall({
      seq: 3,
      requestId: "tool-1-0",
      toolName: "search_tools",
      outcome: "completed",
      input: { query: "grant" },
      output: { rows: ["a"] },
      durationMs: 12,
    });
    return ledger;
  }

  it("puts the request on the intention frame and the completion on the call frame", async () => {
    const { batches } = await record();
    // The prompt is inside the request, and the request is durable before the
    // provider is contacted: this is the frame a `view` reader opens to see
    // what the agent was asked.
    expect(decode(bodyOf(batches, "model.engine_call_started"))).toBe(
      '{"messages":[{"content":"what did we spend?","role":"user"}]}',
    );
    expect(decode(bodyOf(batches, "model.engine_call_completed"))).toBe(
      '{"model":"anthropic/claude-sonnet-4","text":"four dollars"}',
    );
    expect(bodyOf(batches, "model.engine_call_started")!.contentType).toBe(
      "application/json",
    );
  });

  it("puts the tool's arguments on the intention frame and its result on the call frame", async () => {
    const { batches } = await record();
    expect(decode(bodyOf(batches, "tool.engine_call_started"))).toBe(
      '{"query":"grant"}',
    );
    // The result alone: the arguments are already on the frame above, and
    // writing them twice would double every tool argument in the run.
    expect(decode(bodyOf(batches, "tool.engine_call_completed"))).toBe(
      '{"rows":["a"]}',
    );
  });

  it("serialises a body canonically, so the same content always digests the same", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 1,
      toolAllowlist: ["search_tools"],
      store: ledger.store,
    });
    await recorder.toolCallStarted({
      seq: 1,
      requestId: "t",
      toolName: "search_tools",
      input: { b: 2, a: 1 },
    });
    expect(decode(bodyOf(ledger.batches, "tool.engine_call_started"))).toBe(
      '{"a":1,"b":2}',
    );
  });

  it("records a failed tool's error rather than an output it never produced", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 1,
      toolAllowlist: ["set_budget"],
      store: ledger.store,
    });
    await recorder.toolCall({
      seq: 1,
      requestId: "t",
      toolName: "set_budget",
      outcome: "denied",
      input: { usd: 5 },
      error: "approval denied",
      durationMs: 2,
    });
    expect(decode(bodyOf(ledger.batches, "tool.engine_call_completed"))).toBe(
      '"approval denied"',
    );
  });

  it("writes no body past the cap, and the frame's own digest still names the content", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 1,
      toolAllowlist: ["search_tools"],
      store: ledger.store,
    });
    const huge = { blob: "x".repeat(ASSISTANT_MAX_BODY_BYTES + 1) };
    await recorder.toolCall({
      seq: 1,
      requestId: "t",
      toolName: "search_tools",
      outcome: "completed",
      input: { q: "a" },
      output: huge,
      durationMs: 1,
    });
    const frame = ledger.batches.find(
      (b) => b.events[0]!.eventType === "tool.engine_call_completed",
    )!.events[0]! as {
      body?: unknown;
      payload: { output_digest: string };
    };
    // Truncating would write bytes whose digest names nothing that ever
    // existed; the receipt's digest is what keeps the omission honest.
    expect(frame.body).toBeUndefined();
    expect(frame.payload.output_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records the frame without a body when the content has no canonical form", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "api-chat",
      instruction: "hi",
      maxSteps: 1,
      toolAllowlist: ["search_tools"],
      store: ledger.store,
    });
    // A turn whose content cannot be serialised must still be recorded: a
    // missing body is a smaller loss than a failed append. The model frames
    // are where this is reachable — a tool frame digests its input first, and
    // that digest is fail-closed by design, so an unserialisable tool input
    // aborts the turn rather than recording a call nobody can attribute.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await expect(
      recorder.modelCallStarted({
        seq: 1,
        requestId: "prov-1-0",
        role: "worker",
        provider: "oxagen",
        model: "anthropic/claude-sonnet-4",
        request: cyclic,
      }),
    ).resolves.toBeUndefined();
    expect(bodyOf(ledger.batches, "model.engine_call_started")).toBeUndefined();
  });

  // #4171: the run says a summary stood in for the thread's older messages,
  // names it by digest, and keeps its text as the body.
  it("records the history summary the turn carried as a context frame", async () => {
    setupRun();
    const ledger = fakeStore();
    const recorder = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "which cost centre?",
      maxSteps: 1,
      toolAllowlist: ["search_tools"],
      store: ledger.store,
    });
    const text = "- The person's cost centre is CC-7741.";
    await recorder.historySummary({
      outcome: "applied",
      digest: digestJcs(text),
      chars: text.length,
      coveredMessages: 80,
      windowMessages: 40,
      regenerated: true,
      text,
    });
    await recorder.historySummary({
      outcome: "unavailable",
      digest: null,
      chars: null,
      coveredMessages: 0,
      windowMessages: 50,
      regenerated: false,
      reasonCode: "summary_timeout",
      text: null,
    });
    const frames = ledger.batches
      .map((b) => b.events[0]!)
      .filter((e) => e.eventType === "context.history_summarized");
    expect(frames.map((f) => f.payload)).toEqual([
      {
        provider: HISTORY_SUMMARY_PROVIDER,
        outcome: "applied",
        summary_digest: digestJcs(text),
        summary_chars: text.length,
        covered_message_count: 80,
        window_message_count: 40,
        regenerated: true,
      },
      {
        provider: HISTORY_SUMMARY_PROVIDER,
        outcome: "unavailable",
        covered_message_count: 0,
        window_message_count: 50,
        regenerated: false,
        reason_code: "summary_timeout",
      },
    ]);
    // The ledger's own registry takes both payloads as written.
    for (const frame of frames) {
      expect(() =>
        validateInlineEventPayload(frame.eventType, frame.payload),
      ).not.toThrow();
    }
    expect(decode(frames[0]!.body)).toBe(JSON.stringify(text));
    expect(frames[1]!.body).toBeUndefined();
  });
});

// #4158: what the assembler put in the turn's prompt, and what it cut, on the
// run as the frame kind a wrapped agent's host seals for the same account.
describe("the steering manifest frame", () => {
  const decode = (body: { bytes: Uint8Array } | undefined) =>
    body === undefined ? undefined : new TextDecoder().decode(body.bytes);
  const manifestEvent = (batches: readonly AppendAttemptBatchInput[]) =>
    batches.find((b) => b.events[0]!.eventType === "steering.manifest")
      ?.events[0];

  async function recorder() {
    setupRun();
    const ledger = fakeStore();
    const run = await openAssistantRun({
      ...SCOPE,
      userId: USER,
      surface: "chat",
      instruction: "hi",
      maxSteps: 1,
      toolAllowlist: ["search_tools"],
      store: ledger.store,
    });
    return { ledger, run };
  }

  const RECORD = {
    id: "ask-before-deleting",
    kind: "record" as const,
    force: "must" as const,
    body: "Ask before deleting data. (rule; ask-before-deleting)",
    recordedAt: "2026-09-10T00:00:00.000Z",
  };

  it("carries the summary inline, the manifest as its body, and passes the ledger's registry", async () => {
    const { ledger, run } = await recorder();
    const steering = assembleAssistantSteering({
      ...SCOPE,
      records: [RECORD],
      promptConfig: { additionalInstructions: "Answer in British English." },
    });
    await run.steeringManifest(steering);

    const event = manifestEvent(ledger.batches)!;
    expect(event.payload).toEqual({
      schema: "oxagen.steering.manifest/1",
      delivers: ["must", "should"],
      budget_tokens: steering.manifest.budget_tokens,
      spent_tokens: steering.manifest.spent_tokens,
      included: 2,
      cut: 0,
      text_digest: steering.manifest.text_digest,
      manifest_digest: digestOfCanonicalJson(steering.manifest),
      instructions_digest: steering.instructionsDigest,
    });
    // The real store validates every payload against the registry before it
    // writes; the fake does not, so the check is made here.
    expect(
      validateInlineEventPayload("steering.manifest", event.payload).stage,
    ).toBe("context");
    expect(JSON.parse(decode(event.body)!)).toEqual(steering.manifest);
    expect(event.body!.contentType).toBe("application/json");
  });

  it("names a source that did not answer, and no instructions digest when none were configured", async () => {
    const { ledger, run } = await recorder();
    await run.steeringManifest(
      assembleAssistantSteering({
        ...SCOPE,
        records: [],
        promptConfig: null,
        unavailableKinds: ["record"],
      }),
    );
    const payload = manifestEvent(ledger.batches)!.payload as Record<
      string,
      unknown
    >;
    expect(payload["unavailable_kinds"]).toEqual(["record"]);
    expect(payload).not.toHaveProperty("instructions_digest");
    expect(payload["text_digest"]).toBeNull();
    expect(
      validateInlineEventPayload("steering.manifest", payload).eventType,
    ).toBe("steering.manifest");
  });
});

describe("assistantRunStore", () => {
  it("is built with a body store, because the assistant's frames carry bodies", () => {
    // The unit tests above all inject their own store, so none of them reaches
    // the constructor. Without this, a store missing `bodies` passes every
    // test here and then refuses the first frame of every turn in production,
    // because ASSISTANT_RETENTION_POLICY retains every content class and
    // `resolveBodyColumns` raises rather than downgrading the run.
    storeOptions.length = 0;
    assistantRunStore();
    const options = storeOptions.at(-1);
    expect(options?.["bodies"]).toBeDefined();
    expect(options?.["archive"]).toBeDefined();
  });
});
