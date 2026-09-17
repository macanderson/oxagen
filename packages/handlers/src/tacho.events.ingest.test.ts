import type { CapabilityContext } from "@oxagen/oxagen";
import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { schema } from "@oxagen/database";
import { Param, SQL } from "drizzle-orm";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertTachoEvents: vi.fn(),
  selectTachoEvents: vi.fn(),
  withTenantDb: vi.fn(),
  loggerError: vi.fn(),
  unlockOnboardingGate: vi.fn(),
  recordSpend: vi.fn(),
  sendEvent: vi.fn(),
  bodyPut: vi.fn(),
  recordProofFrames: vi.fn(),
}));

vi.mock("./lib/proof", () => ({
  recordProofFrames: mocks.recordProofFrames,
}));

vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ put: mocks.bodyPut }),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...original,
    insertTachoEvents: mocks.insertTachoEvents,
    selectTachoEvents: mocks.selectTachoEvents,
  };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("./lib/onboarding", () => ({
  unlockOnboardingGate: mocks.unlockOnboardingGate,
}));

vi.mock("@oxagen/billing", () => ({ recordSpend: mocks.recordSpend }));
vi.mock("./event-client", () => ({
  eventClient: { send: mocks.sendEvent },
}));

import { digestBytes } from "@oxagen/tacho";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { foldDelta, tachoEventsIngestHandler } from "./tacho.events.ingest";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ENROLLER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ENROLLER_PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const SESSION = sessionUuid(HOST_PUBLIC, "sess-1");

type AgentLabel = Pick<TachoEvent["agent"], "runtime" | "harness"> &
  Partial<Pick<TachoEvent["agent"], "enforcement_tier">>;
const CLAUDE_CODE: AgentLabel = {
  runtime: "claude-code",
  harness: "claude-code",
};

function unsealed(
  kind: UnsealedTachoEvent["kind"],
  body: Record<string, unknown>,
  source: TachoEvent["source"] = "hook",
  label: AgentLabel = CLAUDE_CODE,
  extra: Partial<UnsealedTachoEvent> = {},
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source,
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      ...label,
      wrapper_version: "2.1.1",
      host_enrollment_id: HOST_PUBLIC,
    },
    context: {
      cwd: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    },
    ...extra,
    kind,
    body,
  } as UnsealedTachoEvent;
}

function session(): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of [
    unsealed("agent_start", {
      session_start_source: "startup",
      tools_available: ["Read"],
    }),
    unsealed("turn_start", { prompt_length: 3 }),
    unsealed(
      "llm_call",
      {
        model: "claude-haiku-4-5-20251001",
        input_tokens: 10,
        output_tokens: 5,
        cost_usd_micros: 1200,
        api_duration_ms: 30,
      },
      "otel_log",
    ),
    unsealed("tool_requested", {
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      effect_kind: "command",
      tool_target: "echo hi",
    }),
    unsealed("tool_call", {
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_status: "ok",
      effect_kind: "command",
      tool_target: "echo hi",
      tool_input_digest: `sha256:${"b".repeat(64)}`,
    }),
    unsealed("command", {
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_status: "ok",
      effect_kind: "command",
      tool_target: "echo hi",
      effect_id: "eff_1",
      tool_input_digest: `sha256:${"b".repeat(64)}`,
    }),
    unsealed("file_io", {
      tool_name: "Write",
      tool_use_id: "toolu_2",
      effect_kind: "file_write",
      tool_target: "/home/dev/proj/a.txt",
      effect_id: "eff_2",
      tool_input_bytes: 12,
    }),
    unsealed("turn_end", {}),
    unsealed("agent_stop", {
      session_outcome: "completed",
      session_end_reason: "other",
      total_cost_usd_micros: 1500,
      duration_ms: 900,
    }),
  ]) {
    const sealed = sealEvent(draft, cursor);
    cursor = sealed.next;
    out.push(sealed.event);
  }
  return out;
}

interface FakeDb {
  hosts: Array<Record<string, unknown>>;
  principals: Array<Record<string, unknown>>;
  principalLookups: ReturnType<typeof vi.fn>;
  sessions: Map<string, Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  controlCommands: Array<Record<string, unknown>>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  /** The workspace's latest retention policy row; none by default. */
  retentionPolicy:
    | { mode: string; retainedContentClasses: string[] }
    | undefined;
}

function fakeDb(): FakeDb {
  return {
    hosts: [
      {
        id: HOST_ID,
        publicId: HOST_PUBLIC,
        apiKeyId: "aky_host",
        orgId: CONTEXT.orgId,
        workspaceId: CONTEXT.workspaceId,
        status: "active",
        mode: "observe",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        bundleVersionServed: null,
        createdById: ENROLLER_USER_ID,
      },
    ],
    principals: [
      {
        id: ENROLLER_PRINCIPAL_ID,
        orgId: CONTEXT.orgId,
        parentUserId: ENROLLER_USER_ID,
        kind: "human",
      },
    ],
    principalLookups: vi.fn(),
    sessions: new Map(),
    models: [],
    files: [],
    commands: [],
    controlCommands: [
      {
        id: "c1",
        publicId: "tcm_1",
        hostId: HOST_ID,
        outcome: "queued",
        command: "message",
        payload: { text: "hello" },
        requestedMode: "next_step",
        deliveryMode: "next_step",
        degradedReason: null,
        reason: null,
        issuedAt: new Date("2026-09-08T10:00:00.000Z"),
        expiresAt: null,
      },
    ],
    updates: [],
    retentionPolicy: undefined,
  };
}

function tableName(table: unknown): string {
  const symbols = Object.getOwnPropertySymbols(table as object);
  for (const symbol of symbols) {
    if (symbol.description === "drizzle:Name")
      return (table as Record<symbol, string>)[symbol] ?? "?";
  }
  return "unknown";
}

/** Every value a drizzle condition binds, in order. */
function boundValues(node: unknown): unknown[] {
  if (node instanceof Param) return [node.value];
  if (node instanceof SQL) return node.queryChunks.flatMap(boundValues);
  return [];
}

/** The session row a `tacho.sessions` lookup names: the row keyed by a session uuid it binds. */
function sessionNamed(db: FakeDb, where: unknown) {
  for (const value of boundValues(where)) {
    const row = db.sessions.get(value as string);
    if (row) return row;
  }
  return undefined;
}

function wire(db: FakeDb): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          apiKeys: {
            findFirst: async () => ({
              id: "aky_host",
              scope: {
                purpose: "tacho_host_v1",
                host_enrollment_id: HOST_PUBLIC,
              },
            }),
          },
          tachoHosts: { findFirst: async () => db.hosts[0] },
          principals: {
            findFirst: async () => {
              db.principalLookups();
              return db.principals[0];
            },
          },
          tachoSessions: {
            findFirst: async (args: { where?: unknown }) =>
              sessionNamed(db, args.where),
          },
          authorizationDenyGenerations: {
            findMany: async () => [
              { workspaceId: null, generation: 4 },
              { workspaceId: CONTEXT.workspaceId, generation: 2 },
            ],
          },
          tachoControlCommands: {
            findMany: async () =>
              db.controlCommands.filter((c) => c["outcome"] === "queued"),
          },
          retentionPolicyVersions: {
            findFirst: async () => db.retentionPolicy,
          },
        },
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            const name = tableName(table);
            const chain = {
              onConflictDoUpdate: async () => {
                if (name === "sessions")
                  db.sessions.set(values["sessionUuid"] as string, {
                    id: "s1",
                    publicId: "tse_fake0000000000000001",
                    ...values,
                  });
                if (name === "session_models") db.models.push(values);
                if (name === "session_files") db.files.push(values);
              },
              onConflictDoNothing: async () => {
                if (name === "session_commands") db.commands.push(values);
              },
              returning: async () => [{ id: "new" }],
            };
            return chain;
          },
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              const name = tableName(table);
              db.updates.push({ table: name, values });
              if (name === "control_commands" && values["outcome"] === "sent") {
                for (const command of db.controlCommands)
                  command["outcome"] = "sent";
              }
              if (name === "sessions") {
                const current = db.sessions.get(SESSION);
                if (current) Object.assign(current, values);
              }
              return [];
            },
          }),
        }),
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertTachoEvents.mockResolvedValue(undefined);
  mocks.selectTachoEvents.mockResolvedValue([]);
  mocks.bodyPut.mockImplementation(async (input: { digest: string }) => ({
    ref: `evb:v1:test:${input.digest.slice(7)}`,
  }));
  mocks.unlockOnboardingGate.mockResolvedValue(false);
  mocks.recordSpend.mockResolvedValue(undefined);
  mocks.sendEvent.mockResolvedValue(undefined);
  mocks.recordProofFrames.mockResolvedValue({ written: 0, witnessRunIds: [] });
});

describe("ingest_tacho_events", () => {
  it("accepts a verified session, rolls it up, and answers the control envelope", async () => {
    const db = fakeDb();
    wire(db);
    const events = session();
    const output = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 3 },
      },
      CONTEXT,
    );
    expect(output.accepted).toBe(events.length);
    expect(output.event_ids).toEqual(events.map((e) => e.event_id_idem));
    expect(output.chain_breaks).toEqual([]);
    expect(output.control).toMatchObject({
      host_status: "active",
      deny_generation: { org: 4, workspace: 2 },
      commands: [
        { id: "tcm_1", command: "message", payload: { text: "hello" } },
      ],
    });
    expect(output.control.bundle_etag).toMatch(/^[0-9a-f]{32}$/);

    const inserts = mocks.insertTachoEvents.mock.calls[0]?.[0] as Array<{
      chainVerified: boolean;
    }>;
    expect(inserts).toHaveLength(events.length);
    expect(inserts.every((insert) => insert.chainVerified)).toBe(true);

    // The batch's cost moves the spend-budget counter, and the seal of a
    // root session asks the rollup job for the run's cost row.
    expect(mocks.recordSpend).toHaveBeenCalledTimes(1);
    expect(mocks.recordSpend.mock.calls[0]?.[0]).toMatchObject({
      orgId: CONTEXT.orgId,
      workspaceId: CONTEXT.workspaceId,
      micros: 1200n,
    });
    expect(mocks.sendEvent).toHaveBeenCalledWith({
      name: "cost/run.sealed",
      data: {
        runId: "tse_fake0000000000000001",
        orgId: CONTEXT.orgId,
        workspaceId: CONTEXT.workspaceId,
      },
    });
    // The rollup job reads ClickHouse on receipt, so the frames land first.
    expect(mocks.insertTachoEvents.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendEvent.mock.invocationCallOrder[0] as number,
    );

    const row = db.sessions.get(SESSION);
    expect(row).toMatchObject({
      harnessSessionId: "sess-1",
      hostId: HOST_ID,
      agentKey: "acme.core.cc-laptop",
      modelInitial: "claude-haiku-4-5-20251001",
      outcome: "completed",
      cwd: "/home/dev/proj",
      toolsAvailable: ["Read"],
      chainVerified: true,
      initiatingPrincipalId: ENROLLER_PRINCIPAL_ID,
    });
    expect(db.principalLookups).toHaveBeenCalledOnce();
    expect(db.models[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      requests: 1,
      inputTokens: 10,
      costMicros: 1200,
    });
    expect(db.files[0]).toMatchObject({
      path: "/home/dev/proj/a.txt",
      writes: 1,
      bytesWritten: 12,
    });
    expect(db.commands[0]).toMatchObject({
      commandHead: "echo hi",
      bashCommand: "echo",
      status: "ok",
    });
    const hostTouch = db.updates.find(
      (u) => u.table === "hosts" && u.values["lastIngestAt"] !== undefined,
    );
    expect(hostTouch?.values).toMatchObject({
      daemonVersion: "2.1.1",
      hooksOk: true,
      spoolDepth: 3,
    });
  });

  describe("the enforcement tier is the control plane's verdict", () => {
    // `enforcement_tier: "gateway"` is the claim that Oxagen itself served
    // and could refuse the action (ADR-078 section 5). A batch is a report
    // from the machine, and every agent on an enrolled host can reach the
    // ingest endpoint with the host key, so a tier taken off the wire is a
    // tier the governed agent writes about itself. It seals into a valid
    // chain because the producer computes the chain.
    const GATEWAY_CLAIM: AgentLabel = {
      ...CLAUDE_CODE,
      enforcement_tier: "gateway",
    };

    function claimed(label: AgentLabel): TachoEvent[] {
      let cursor: ChainCursor = GENESIS_CURSOR;
      const out: TachoEvent[] = [];
      for (const draft of [
        unsealed(
          "agent_start",
          { session_start_source: "startup" },
          "hook",
          label,
        ),
        unsealed("turn_start", { prompt_length: 3 }, "hook", label),
      ]) {
        const sealed = sealEvent(draft, cursor);
        cursor = sealed.next;
        out.push(sealed.event);
      }
      return out;
    }

    async function ingest(events: TachoEvent[]) {
      return tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events,
          daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
        },
        CONTEXT,
      );
    }

    it("refuses a producer's gateway claim and records what the host mode implies", async () => {
      const db = fakeDb();
      wire(db);
      const events = claimed(GATEWAY_CLAIM);
      expect(events[0]?.agent.enforcement_tier).toBe("gateway");

      await ingest(events);

      expect(db.sessions.get(SESSION)).toMatchObject({
        enforcementTier: "observe",
      });
      const inserts = mocks.insertTachoEvents.mock.calls[0]?.[0] as Array<{
        enforcementTier: string;
      }>;
      expect(inserts.every((i) => i.enforcementTier === "observe")).toBe(true);
    });

    it("still refuses the claim on an enforcing host, recording harness", async () => {
      const db = fakeDb();
      (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
      wire(db);

      await ingest(claimed(GATEWAY_CLAIM));

      expect(db.sessions.get(SESSION)).toMatchObject({
        enforcementTier: "harness",
      });
    });

    it("takes an honest downgrade at its word", async () => {
      const db = fakeDb();
      (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
      wire(db);

      await ingest(claimed({ ...CLAUDE_CODE, enforcement_tier: "observe" }));

      expect(db.sessions.get(SESSION)).toMatchObject({
        enforcementTier: "observe",
      });
    });

    it("never promotes a session already on the record", async () => {
      const db = fakeDb();
      wire(db);
      await ingest(claimed(CLAUDE_CODE));
      expect(db.sessions.get(SESSION)).toMatchObject({
        enforcementTier: "observe",
      });

      // A second batch on the same session, now claiming gateway. The row
      // exists, so the update path runs — and it must not carry the column.
      await ingest(claimed(GATEWAY_CLAIM));

      expect(db.sessions.get(SESSION)).toMatchObject({
        enforcementTier: "observe",
      });
      expect(
        db.updates.some(
          (u) => u.table === "sessions" && "enforcementTier" in u.values,
        ),
      ).toBe(false);
    });
  });

  it("files a Codex session under runtime codex, not custom", async () => {
    const db = fakeDb();
    wire(db);
    const codex: AgentLabel = { runtime: "codex", harness: "codex" };
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed(
        "agent_start",
        { session_start_source: "startup", tools_available: ["shell"] },
        "hook",
        codex,
      ),
      unsealed(
        "agent_stop",
        {
          session_outcome: "completed",
          session_end_reason: "other",
          total_cost_usd_micros: 0,
          duration_ms: 10,
        },
        "hook",
        codex,
      ),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    const output = await tachoEventsIngestHandler(
      { schema: "tacho.batch.v1", host_enrollment_id: HOST_PUBLIC, events },
      CONTEXT,
    );
    expect(output.accepted).toBe(2);
    expect(output.chain_breaks).toEqual([]);
    const row = db.sessions.get(SESSION);
    expect(row).toMatchObject({ runtime: "codex", harness: "codex" });
    // The row's runtime is a value the database CHECK admits; the fleet page
    // can filter on it without reading the free-text harness.
    expect(schema.TACHO_RUNTIMES).toContain(row?.["runtime"]);
  });

  it("records a chain break without rejecting the batch", async () => {
    const db = fakeDb();
    wire(db);
    const events = session();
    const tampered = structuredClone(events);
    (tampered[2] as TachoEvent & { body: Record<string, unknown> }).body[
      "input_tokens"
    ] = 999;
    const output = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: tampered,
      },
      CONTEXT,
    );
    expect(output.accepted).toBe(events.length);
    expect(output.chain_breaks).toEqual([
      {
        session_uuid: SESSION,
        at_seq: 0,
        reason: expect.stringContaining("seq 2 hash does not match"),
      },
    ]);
    const inserts = mocks.insertTachoEvents.mock.calls[0]?.[0] as Array<{
      chainVerified: boolean;
    }>;
    expect(inserts.every((insert) => !insert.chainVerified)).toBe(true);
    expect(db.sessions.get(SESSION)).toMatchObject({
      chainVerified: false,
      chainBreakAtSeq: 0,
    });
  });

  it("opens the onboarding gate on a new root session, binding it to the host's agent (#2967)", async () => {
    const db = fakeDb();
    db.hosts[0]!["agentId"] = "agent-uuid";
    db.hosts[0]!["agentPrincipalId"] = "agent-principal-uuid";
    wire(db);
    mocks.unlockOnboardingGate.mockResolvedValueOnce(true);
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: session(),
      },
      CONTEXT,
    );
    expect(mocks.unlockOnboardingGate).toHaveBeenCalledTimes(1);
    expect(mocks.unlockOnboardingGate.mock.calls[0]?.[1]).toMatchObject({
      orgId: CONTEXT.orgId,
      runPublicId: "tse_fake0000000000000001",
      agentId: "agent-uuid",
    });
    // The session is the agent's run, not only the host's.
    expect(db.sessions.get(SESSION)).toMatchObject({
      agentId: "agent-uuid",
      agentPrincipalId: "agent-principal-uuid",
    });
  });

  it("leaves the gate alone for a continuation batch and for a subagent's session", async () => {
    const db = fakeDb();
    const events = session();
    db.sessions.set(SESSION, {
      id: "s1",
      publicId: "tse_s1",
      seqCount: 3,
      lastHash: events[2]?.hash,
      chainVerified: true,
      hostId: HOST_ID,
    });
    wire(db);
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: events.slice(3),
      },
      CONTEXT,
    );
    expect(mocks.unlockOnboardingGate).not.toHaveBeenCalled();

    const child = fakeDb();
    wire(child);
    let cursor: ChainCursor = GENESIS_CURSOR;
    const subagent: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("agent_stop", {
        session_outcome: "completed",
        session_end_reason: "other",
      }),
    ]) {
      const sealed = sealEvent(
        { ...draft, parent_session_uuid: SESSION },
        cursor,
      );
      cursor = sealed.next;
      subagent.push(sealed.event);
    }
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: subagent,
      },
      CONTEXT,
    );
    expect(mocks.unlockOnboardingGate).not.toHaveBeenCalled();
  });

  it("continues a known session only from its recorded head", async () => {
    const db = fakeDb();
    const events = session();
    db.sessions.set(SESSION, {
      id: "s1",
      seqCount: 3,
      lastHash: events[2]?.hash,
      chainVerified: true,
      hostId: HOST_ID,
    });
    wire(db);
    const tail = events.slice(3);
    const good = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: tail,
      },
      CONTEXT,
    );
    expect(good.chain_breaks).toEqual([]);

    db.sessions.set(SESSION, {
      id: "s1",
      seqCount: 3,
      lastHash: `sha256:${"f".repeat(64)}`,
      chainVerified: true,
      hostId: HOST_ID,
    });
    const broken = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: tail,
      },
      CONTEXT,
    );
    expect(broken.chain_breaks[0]?.reason).toContain("recorded chain head");
  });

  it("attributes nobody when the host has no enroller or the enroller has no principal", async () => {
    const orphan = fakeDb();
    (orphan.hosts[0] as Record<string, unknown>)["createdById"] = null;
    wire(orphan);
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: session(),
      },
      CONTEXT,
    );
    expect(orphan.sessions.get(SESSION)).toMatchObject({
      initiatingPrincipalId: null,
    });
    expect(orphan.principalLookups).not.toHaveBeenCalled();

    const unprovisioned = fakeDb();
    unprovisioned.principals = [];
    wire(unprovisioned);
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: session(),
      },
      CONTEXT,
    );
    expect(unprovisioned.sessions.get(SESSION)).toMatchObject({
      initiatingPrincipalId: null,
    });
    expect(unprovisioned.principalLookups).toHaveBeenCalledOnce();
  });

  it("leaves an existing session's initiating principal as recorded", async () => {
    const db = fakeDb();
    const events = session();
    const recorded = "44444444-4444-4444-8444-444444444444";
    db.sessions.set(SESSION, {
      id: "s1",
      seqCount: 3,
      lastHash: events[2]?.hash,
      chainVerified: true,
      hostId: HOST_ID,
      initiatingPrincipalId: recorded,
    });
    wire(db);
    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: events.slice(3),
      },
      CONTEXT,
    );
    expect(db.sessions.get(SESSION)).toMatchObject({
      initiatingPrincipalId: recorded,
      outcome: "completed",
    });
    expect(db.principalLookups).not.toHaveBeenCalled();
    const sessionUpdates = db.updates.filter((u) => u.table === "sessions");
    expect(sessionUpdates.length).toBeGreaterThan(0);
    for (const update of sessionUpdates)
      expect(update.values).not.toHaveProperty("initiatingPrincipalId");
  });

  it("denies a batch that names another host, a missing key, or a revoked host, and writes none of its bodies", async () => {
    const db = fakeDb();
    wire(db);
    const events = sessionWithContent();
    const bodies = [bodyFor(events[1] as TachoEvent)];
    const foreign = structuredClone(events);
    for (const event of foreign)
      event.agent.host_enrollment_id = "tch_zzzzzzzzzzzzzzzzzzzzzz";
    await expect(
      tachoEventsIngestHandler(batch(foreign, bodies), CONTEXT),
    ).rejects.toThrow(/another host/);
    await expect(
      tachoEventsIngestHandler(batch(events, bodies), {
        ...CONTEXT,
        apiKeyId: null,
      }),
    ).rejects.toThrow(/API key required/);
    const revoked = fakeDb();
    (revoked.hosts[0] as Record<string, unknown>)["status"] = "revoked";
    wire(revoked);
    await expect(
      tachoEventsIngestHandler(batch(events, bodies), CONTEXT),
    ).rejects.toThrow(/revoked/);
    expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
    // The host is refused before any body reaches the tenant's store.
    expect(mocks.bodyPut).not.toHaveBeenCalled();
  });

  it("surfaces a ClickHouse append failure after logging it", async () => {
    const db = fakeDb();
    wire(db);
    mocks.insertTachoEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events: session(),
        },
        CONTEXT,
      ),
    ).rejects.toThrow("clickhouse down");
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("folds every counted kind into the session delta", () => {
    const delta = {
      numTurns: 0,
      numPrompts: 0,
      numModelCalls: 0,
      numApiErrors: 0,
      numToolCalls: 0,
      numToolErrors: 0,
      numToolRejections: 0,
      numSubagents: 0,
      numCompactions: 0,
      numModelSwitches: 0,
      numNotifications: 0,
      numElicitations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      thinkingTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      totalCostMicros: 0,
      policyDecisions: 0,
      policyDenies: 0,
      telemetryGapCount: 0,
      filesRead: 0,
      filesWritten: 0,
      filesDeleted: 0,
      commandsRun: 0,
      networkCalls: 0,
    };
    let cursor: ChainCursor = GENESIS_CURSOR;
    const seal = (draft: UnsealedTachoEvent) => {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      return sealed.event;
    };
    for (const event of [
      seal(unsealed("agent_start", {})),
      seal(
        unsealed(
          "llm_call",
          { thinking_tokens: 7, cache_creation_1h_tokens: 3 },
          "transcript",
        ),
      ),
      seal(unsealed("error", { api_status_code: 529 }, "otel_log")),
      seal(
        unsealed("tool_call", {
          tool_status: "error",
          effect_kind: "file_read",
        }),
      ),
      seal(unsealed("policy_decision", { policy_decision: "deny" })),
      seal(unsealed("network", { effect_kind: "network" })),
      seal(unsealed("subagent_start", {})),
      seal(unsealed("oxagen:notification", {})),
      seal(unsealed("oxagen:elicitation", {})),
      seal(unsealed("telemetry_gap", {})),
      seal(
        unsealed(
          "oxagen:model_switch",
          { model_switch_reason: "PostModelSwitch" },
          "hook",
        ),
      ),
    ]) {
      if (event.kind === "oxagen:model_switch")
        (event as { hook_event_name?: string }).hook_event_name =
          "PostModelSwitch";
      foldDelta(delta, event);
    }
    expect(delta).toMatchObject({
      thinkingTokens: 7,
      cacheCreation1hTokens: 3,
      numApiErrors: 1,
      numToolCalls: 1,
      numToolErrors: 1,
      filesRead: 1,
      policyDecisions: 1,
      policyDenies: 1,
      networkCalls: 1,
      numSubagents: 1,
      numNotifications: 1,
      numElicitations: 1,
      telemetryGapCount: 1,
      numModelSwitches: 1,
    });
  });

  describe("the person behind the session (#3072)", () => {
    const ADDRESS = "Ada.Lovelace@example.com";
    const LEGACY_DIGEST = `sha256:${"7".repeat(64)}`;

    function batch(
      anthropic: Record<string, string> | undefined,
    ): TachoEvent[] {
      let cursor: ChainCursor = GENESIS_CURSOR;
      const out: TachoEvent[] = [];
      for (const draft of [
        unsealed(
          "agent_start",
          { session_start_source: "startup" },
          "hook",
          CLAUDE_CODE,
          anthropic ? { anthropic } : {},
        ),
        unsealed("turn_start", { prompt_length: 3 }),
        unsealed("turn_end", {}),
      ]) {
        const sealed = sealEvent(draft, cursor);
        cursor = sealed.next;
        out.push(sealed.event);
      }
      return out;
    }

    function run(events: TachoEvent[]) {
      return tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events,
          daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
        },
        CONTEXT,
      );
    }

    /**
     * The literal values this ingest persists for one submitted batch. Drizzle
     * `sql\`col + n\`` increments are fresh objects on every call, so they are
     * dropped: they encode a counter bump and carry nothing from the producer.
     */
    function literals(row: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const kind = typeof value;
        if (
          value === null ||
          kind === "string" ||
          kind === "number" ||
          kind === "boolean" ||
          Array.isArray(value)
        ) {
          out[key] = value;
        }
      }
      return out;
    }

    async function persisted(anthropic: Record<string, string> | undefined) {
      mocks.insertTachoEvents.mockClear();
      const db = fakeDb();
      wire(db);
      await run(batch(anthropic));
      const sent = (mocks.insertTachoEvents.mock.calls[0]?.[0] ?? []) as Array<{
        event: TachoEvent;
        [k: string]: unknown;
      }>;
      return {
        session: literals(db.sessions.get(SESSION) as Record<string, unknown>),
        // what reaches ClickHouse, minus the producer's own event echo
        clickhouse: sent.map(({ event: _event, ...stamped }) => stamped),
      };
    }

    it("is not an oracle: the response does not vary with a producer-chosen pre-image", async () => {
      // THE FINDING. A host key may ingest and an org Member may read the
      // session back, so if any stored value were a stable function of the
      // producer-supplied `anthropic` block, a tenant could submit the hash of
      // a guessed address, read the result, and compare it against a
      // colleague's row until it matched. Keeping a key secret does not help
      // when the server computes the function on demand for chosen inputs.
      //
      // The property that closes it: nothing persisted depends on that block.
      const guessA = await persisted({
        user_email_digest: `sha256:${"a".repeat(64)}`,
      });
      const guessB = await persisted({
        user_email_digest: `sha256:${"b".repeat(64)}`,
      });
      const legacy = await persisted({ user_email: ADDRESS });
      const nobody = await persisted(undefined);

      // The chain hashes are the one permitted difference, and they are not an
      // oracle: the producer computes them itself before submitting, so it
      // learns nothing back, and each covers the whole sealed event rather than
      // the address. Reproducing a colleague's hash would mean reproducing
      // their entire event, not guessing their address.
      const CHAIN = ["genesisHash", "lastHash"];
      const variesFrom = (other: Record<string, unknown>) =>
        Object.keys(guessA.session)
          .filter(
            (k) =>
              JSON.stringify(guessA.session[k]) !== JSON.stringify(other[k]),
          )
          .sort();

      expect(variesFrom(guessB.session)).toEqual(CHAIN);
      expect(variesFrom(legacy.session)).toEqual(CHAIN);
      expect(variesFrom(nobody.session)).toEqual(CHAIN);
      expect(guessA.clickhouse).toEqual(guessB.clickhouse);
      expect(guessA.clickhouse).toEqual(legacy.clickhouse);
    });

    it("stores nothing derived from the address, in either store", async () => {
      const { session, clickhouse } = await persisted({
        user_email: ADDRESS,
        // What a collector from the previous round still sends. It computes
        // this itself; the control plane accepts it and stores nothing.
        user_email_digest: LEGACY_DIGEST,
      });
      const written = JSON.stringify({ session, clickhouse });
      expect(written).not.toContain("@example.com");
      expect(written).not.toContain(LEGACY_DIGEST);
      for (const key of Object.keys(session)) {
        expect(key.toLowerCase()).not.toContain("email");
      }
    });

    it("still accepts a legacy batch whole, so installed collectors keep reporting", async () => {
      // An installed collector, or an upgraded one draining a WAL sealed before
      // the change, still sends anthropic.user_email. Rejecting it took the
      // WHOLE batch down and left those sealed entries unsendable.
      const db = fakeDb();
      wire(db);
      const events = batch({ user_email: ADDRESS });

      const output = await run(events);

      expect(output.accepted).toBe(events.length);
      expect(output.chain_breaks).toEqual([]);
      expect(output.event_ids).toEqual(events.map((e) => e.event_id_idem));
    });

    it("accepts a sealed legacy batch through the REAL request validator, not just the handler", async () => {
      // The reviewed break was at the request validator, one layer above the
      // handler: `apps/api/src/routes/v1/tacho.events.ingest.ts:56` runs
      // `tachoEventsIngest.input.parse(rawInput)` BEFORE `invoke()`, and that
      // input is `anthropicSchema`, which is `.strict()`. A test that calls
      // `tachoEventsIngestHandler` directly passes on exactly the
      // implementation the finding describes, because the batch would already
      // have been rejected before the handler ran. So parse first, with the
      // contract's own schema, and only hand the PARSED value on.
      const events = batch({ user_email: ADDRESS });
      const submitted = {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      };

      const parsed = tachoEventsIngest.input.safeParse(submitted);
      expect(parsed.error?.issues ?? []).toEqual([]);
      if (!parsed.success) throw new Error("unreachable");

      // The member survives validation rather than being stripped. It has to:
      // the seal covers every member, so a stripped one breaks the chain for a
      // WAL entry sealed before this change.
      const first = parsed.data.events[0] as TachoEvent;
      expect(first.anthropic?.user_email).toBe(ADDRESS);

      mocks.insertTachoEvents.mockClear();
      const db = fakeDb();
      wire(db);
      const output = await tachoEventsIngestHandler(parsed.data, CONTEXT);

      expect(output.accepted).toBe(events.length);
      expect(output.chain_breaks).toEqual([]);

      // accepted, and still nothing about the address persisted
      const sent = (mocks.insertTachoEvents.mock.calls[0]?.[0] ?? []) as Array<{
        event: TachoEvent;
        [k: string]: unknown;
      }>;
      const written = JSON.stringify({
        session: literals(db.sessions.get(SESSION) as Record<string, unknown>),
        clickhouse: sent.map(({ event: _event, ...stamped }) => stamped),
      });
      expect(written).not.toContain("@example.com");
      expect(written.toLowerCase()).not.toContain("email");
    });

    it("still rejects an unknown member, so acceptance is not a loosened schema", async () => {
      // Guards the test above. If `anthropicSchema` had been changed from
      // `.strict()` to passthrough, the legacy batch would also be accepted —
      // and every unvetted member the harness invents would be accepted with
      // it. Acceptance of `user_email` has to be a named member, not an
      // absence of checking.
      // `sealEvent` parses too, so the member is injected into the already
      // sealed event rather than passed to `batch` — which is the shape a
      // hostile or buggy host actually submits.
      const events = batch({ user_email: ADDRESS }).map((event, i) =>
        i === 0
          ? {
              ...event,
              anthropic: { ...event.anthropic, invented_member: "x" },
            }
          : event,
      );
      const parsed = tachoEventsIngest.input.safeParse({
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("invented_member");
    });

    it("names the session's person with an identity this deployment issues", async () => {
      // What replaces the digest: the row already carries principals the
      // control plane minted, which a producer cannot choose and which need no
      // key to stay meaningful.
      const { session } = await persisted({ user_email: ADDRESS });
      expect(Object.keys(session)).toEqual(
        expect.arrayContaining(["orgId", "workspaceId", "hostId"]),
      );
    });

    it("queries no column this PR adds, so a deploy before its migration is safe", async () => {
      // #3186: deploy-node ships on merge with no migration dependency
      // (pipeline.yml:802-806) while the Postgres and ClickHouse migrations are
      // dispatched by hand. Code that needs a column the running schema lacks
      // breaks ingestion in that window. This handler writes only columns the
      // deployed schema already has.
      const { session, clickhouse } = await persisted({ user_email: ADDRESS });
      expect(session).not.toHaveProperty("anthropicUserEmailDigest");
      expect(session).not.toHaveProperty("anthropicUserEmail");
      for (const row of clickhouse) {
        // Every key here is a control-plane verdict stamped over the
        // projection, and each names a column the deployed table already has:
        // `chain_verified` and `enforcement_tier` have been in
        // `0027_tacho_events.sql` since the table was created. (`bytesRef` is
        // spread only when a body was retained, and this fixture retains
        // none.) A key naming a column this PR adds is what the test is for.
        expect(Object.keys(row)).toEqual(["chainVerified", "enforcementTier"]);
      }
    });
  });
});

// ── Bodies and the seal (ADR-058) ────────────────────────────────────────────

const TOOL_OUTPUT = '{"stdout":"hi\\n"}';

/**
 * A short session whose tool_call chains a content digest for TOOL_OUTPUT.
 * `tier` is the enforcement tier the events claim; the host's mode decides
 * when they claim none.
 */
/**
 * A content-bearing session. `tier` is what the PRODUCER puts on the envelope
 * — never what the record ends up carrying, since the control plane resolves
 * the tier from its own state (`lib/tacho-enforcement-tier.ts`).
 */
function sessionWithContent(tier?: "gateway" | "harness"): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of [
    unsealed("agent_start", { session_start_source: "startup" }),
    {
      ...unsealed("tool_call", {
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        tool_status: "ok",
        effect_kind: "command",
        tool_target: "echo hi",
      }),
      content: { digest: digestBytes(TOOL_OUTPUT), redactions: [] },
    } as UnsealedTachoEvent,
    unsealed("agent_stop", {
      session_outcome: "completed",
      session_end_reason: "other",
    }),
  ]) {
    if (tier) draft.agent.enforcement_tier = tier;
    const sealed = sealEvent(draft, cursor);
    cursor = sealed.next;
    out.push(sealed.event);
  }
  return out;
}

function batch(events: TachoEvent[], bodies?: unknown[]) {
  return {
    schema: "tacho.batch.v1" as const,
    host_enrollment_id: HOST_PUBLIC,
    events,
    ...(bodies ? { bodies } : {}),
  } as Parameters<typeof tachoEventsIngestHandler>[0];
}

function bodyFor(event: TachoEvent, text = TOOL_OUTPUT) {
  return {
    event_id_idem: event.event_id_idem,
    content_type: "application/json",
    bytes_base64: Buffer.from(text).toString("base64"),
  };
}

describe("ingest_tacho_events: bodies and the seal", () => {
  it("writes a verified body before the row, stamps its reference, and seals view on a harness-tier host", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = sessionWithContent();
    const toolCall = events[1] as TachoEvent;
    const output = await tachoEventsIngestHandler(
      batch(events, [bodyFor(toolCall)]),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([]);
    expect(mocks.bodyPut).toHaveBeenCalledOnce();
    expect(mocks.bodyPut.mock.calls[0]?.[0]).toMatchObject({
      orgId: CONTEXT.orgId,
      workspaceId: CONTEXT.workspaceId,
      runId: SESSION,
      digest: digestBytes(TOOL_OUTPUT),
      contentType: "application/json",
    });
    // The body landed before the ClickHouse append.
    expect(mocks.bodyPut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.insertTachoEvents.mock.invocationCallOrder[0] as number,
    );
    const inserts = mocks.insertTachoEvents.mock.calls[0]?.[0] as Array<{
      event: TachoEvent;
      bytesRef?: string;
    }>;
    expect(inserts.find((i) => i.event === toolCall)?.bytesRef).toBe(
      `evb:v1:test:${digestBytes(TOOL_OUTPUT).slice(7)}`,
    );
    expect(inserts.filter((i) => i.bytesRef !== undefined)).toHaveLength(1);
    const row = db.sessions.get(SESSION);
    // Every content frame has its body on a harness-tier host: view.
    expect(row).toMatchObject({ replayGrade: "view", completenessGaps: [] });
    // The three body counters persist with the session, so a later batch's
    // seal grades from the whole session and not from its own bodies.
    const counters = db.updates.find(
      (u) => u.table === "sessions" && u.values["toolBodyFrames"] !== undefined,
    );
    expect(counters?.values).toHaveProperty("contentFrames");
    expect(counters?.values).toHaveProperty("bodyFrames");
  });

  it("never re-seals or re-counts a re-sent sealing batch, even one that drops its bodies", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = sessionWithContent();
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    const row = db.sessions.get(SESSION) as Record<string, unknown>;
    expect(row).toMatchObject({ replayGrade: "view", completenessGaps: [] });
    // What Postgres holds after the first batch's increments.
    Object.assign(row, {
      contentFrames: 1,
      bodyFrames: 1,
      toolBodyFrames: 1,
      numToolCalls: 1,
      telemetryGapCount: 0,
    });
    const sealedAt = row["sealedAt"];
    db.updates.length = 0;
    const eventsSent = mocks.sendEvent.mock.calls.length;

    await tachoEventsIngestHandler(batch(events), CONTEXT);

    expect(row).toMatchObject({
      replayGrade: "view",
      completenessGaps: [],
      sealedAt,
    });
    const update = db.updates.find((u) => u.table === "sessions");
    expect(update?.values).not.toHaveProperty("replayGrade");
    expect(update?.values).not.toHaveProperty("completenessGaps");
    expect(update?.values).not.toHaveProperty("sealedAt");
    expect(update?.values).not.toHaveProperty("lastHash");
    const dialect = new PgDialect();
    for (const counter of [
      "contentFrames",
      "bodyFrames",
      "toolBodyFrames",
      "numToolCalls",
    ]) {
      const query = dialect.sqlToQuery(update?.values[counter] as SQL);
      expect(query.params, counter).toEqual([0]);
    }
    expect(mocks.bodyPut).toHaveBeenCalledOnce();
    expect(mocks.sendEvent.mock.calls.length).toBe(eventsSent);
  });

  /** What ClickHouse serves after `insertTachoEvents` call `call`, as `selectTachoEvents` rows. */
  function storedRows(call: number) {
    const inserts = mocks.insertTachoEvents.mock.calls[call]?.[0] as Array<{
      event: TachoEvent;
      bytesRef?: string;
    }>;
    return inserts.map((insert) => ({
      seq: insert.event.seq,
      contentDigest: insert.event.content?.digest ?? "",
      bytesRef: insert.bytesRef ?? "",
    }));
  }
  const refOf = (call: number, seq: number) =>
    (
      mocks.insertTachoEvents.mock.calls[call]?.[0] as Array<{
        event: TachoEvent;
        bytesRef?: string;
      }>
    ).find((insert) => insert.event.seq === seq)?.bytesRef;

  it("keeps the stored body reference on a re-sent row whose body the retry dropped", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = sessionWithContent();
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    const firstRef = refOf(0, 1);
    expect(firstRef).toMatch(/^evb:v1:test:/);
    mocks.selectTachoEvents.mockResolvedValue(storedRows(0));

    await tachoEventsIngestHandler(batch(events), CONTEXT);

    expect(mocks.selectTachoEvents).toHaveBeenCalledOnce();
    expect(mocks.selectTachoEvents).toHaveBeenCalledWith({
      sessionUuid: SESSION,
      afterSeq: 0,
      limit: 1,
    });
    expect(refOf(1, 1)).toBe(firstRef);
    expect(mocks.bodyPut).toHaveBeenCalledOnce();
  });

  it("carries no stored reference onto a re-sent row with another content digest (negative)", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = sessionWithContent();
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    mocks.selectTachoEvents.mockResolvedValue(
      storedRows(0).map((row) => ({
        ...row,
        contentDigest: digestBytes("other bytes"),
      })),
    );

    await tachoEventsIngestHandler(batch(events), CONTEXT);

    expect(refOf(1, 1)).toBeUndefined();
  });

  it("seals inspect on an observe-tier host whatever bodies it shipped (spec §8.4)", async () => {
    const db = fakeDb();
    wire(db);
    const events = sessionWithContent();
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(mocks.bodyPut).toHaveBeenCalledOnce();
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "inspect",
      completenessGaps: [],
    });
  });

  // `fork` needs a gateway-tier session (spec section 8.4), and a batch cannot
  // make one: the tier is resolved from server-owned state, so a producer
  // claiming `gateway` buys itself nothing, here least of all a grade. The
  // ladder itself — gateway plus every body grades `fork` — is proved where
  // the tier is a real input, in `lib/tacho-replay.test.ts`.
  it("does not let a producer's gateway claim buy it a fork grade", async () => {
    const db = fakeDb();
    wire(db);
    const events = sessionWithContent("gateway");
    expect(events[0]?.agent.enforcement_tier).toBe("gateway");
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(db.sessions.get(SESSION)).toMatchObject({
      enforcementTier: "observe",
      replayGrade: "inspect",
      completenessGaps: [],
    });
  });

  it("seals below fork when a claimed gateway session kept no result body either (negative)", async () => {
    const db = fakeDb();
    wire(db);
    await tachoEventsIngestHandler(
      batch(sessionWithContent("gateway")),
      CONTEXT,
    );
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "inspect",
      completenessGaps: ["body_missing", "tool_bodies"],
    });
  });

  it("seals inspect on an empty record: no content frame, no body (negative)", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("agent_stop", {
        session_outcome: "completed",
        session_end_reason: "other",
      }),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    await tachoEventsIngestHandler(batch(events), CONTEXT);
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "inspect",
      completenessGaps: [],
    });
  });

  it("seals inspect with body_missing when a content frame arrives without its body", async () => {
    const db = fakeDb();
    wire(db);
    const output = await tachoEventsIngestHandler(
      batch(sessionWithContent()),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([]);
    expect(mocks.bodyPut).not.toHaveBeenCalled();
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "inspect",
      completenessGaps: ["body_missing", "tool_bodies"],
    });
  });

  it("refuses every body under a digest_only workspace and seals with the digest_only gap", async () => {
    const db = fakeDb();
    db.retentionPolicy = { mode: "digest_only", retainedContentClasses: [] };
    wire(db);
    const events = sessionWithContent();
    const output = await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([
      {
        event_id_idem: (events[1] as TachoEvent).event_id_idem,
        reason: "retention_digest_only",
      },
    ]);
    expect(mocks.bodyPut).not.toHaveBeenCalled();
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "inspect",
      completenessGaps: ["digest_only", "tool_bodies"],
    });
  });

  it("refuses a body whose bytes do not hash to the chained digest, and one carrying a credential", async () => {
    const db = fakeDb();
    wire(db);
    const events = sessionWithContent();
    const toolCall = events[1] as TachoEvent;
    const output = await tachoEventsIngestHandler(
      batch(events, [
        bodyFor(toolCall, '{"stdout":"tampered"}'),
        bodyFor(events[0] as TachoEvent),
      ]),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([
      { event_id_idem: toolCall.event_id_idem, reason: "digest_mismatch" },
      {
        event_id_idem: (events[0] as TachoEvent).event_id_idem,
        reason: "no_content_digest",
      },
    ]);
    expect(mocks.bodyPut).not.toHaveBeenCalled();
    expect(db.sessions.get(SESSION)?.["replayGrade"]).toBe("inspect");
  });

  it("seals inspect with chain_break when the chain does not verify", async () => {
    const db = fakeDb();
    wire(db);
    const events = sessionWithContent();
    const forged = events.map((event, i) =>
      i === 1 ? { ...event, hash: `sha256:${"f".repeat(64)}` } : event,
    ) as TachoEvent[];
    await tachoEventsIngestHandler(
      batch(forged, [bodyFor(forged[1] as TachoEvent)]),
      CONTEXT,
    );
    const gaps = db.sessions.get(SESSION)?.["completenessGaps"] as string[];
    expect(gaps).toContain("chain_break");
    expect(db.sessions.get(SESSION)?.["replayGrade"]).toBe("inspect");
  });
});

describe("proof.observed frames (ADR-064)", () => {
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  const FLIP = {
    witness_id: "wit_01K5RQ8M4",
    oracle: "test_flip",
    target_ref: "main",
    target_sha: "a4c91e2",
    pr_ref: "refs/pull/482/head",
    pr_sha: "f70b3d9",
    command_normalized_digest: d("1"),
    target_result: "fail",
    pr_result: "pass",
    verdict: "flipped",
    fail_fingerprint: d("2"),
    pass_output_digest: d("3"),
    tamper_exclusion: "held",
    disclosure_grain: "L0",
    witness_run_id: null,
    runner_attestation: { key_id: "kms:witness/v3", signature: "MEUCIQ" },
  };
  const RUN = "tse_fake0000000000000001";

  function batch(events: TachoEvent[]) {
    return {
      schema: "tacho.batch.v1" as const,
      host_enrollment_id: HOST_PUBLIC,
      events,
    };
  }

  /**
   * A session sealed before this batch, one frame long, and the proof frame
   * that follows it, naming `rootSessionUuid` as its root.
   */
  function sealedSessionAndProof(
    db: FakeDb,
    parentSessionUuid: string | null,
    rootSessionUuid: string = SESSION,
  ) {
    const genesis = sealEvent(
      unsealed("agent_start", { session_start_source: "startup" }),
      GENESIS_CURSOR,
    );
    db.sessions.set(SESSION, {
      id: "s1",
      publicId: RUN,
      sessionUuid: SESSION,
      hostId: HOST_ID,
      seqCount: 1,
      lastHash: genesis.event.hash,
      chainVerified: true,
      telemetryGapCount: 0,
      numToolCalls: 0,
      contentFrames: 0,
      bodyFrames: 0,
      toolBodyFrames: 0,
      enforcementTier: "observe",
      sealedAt: new Date("2026-09-08T10:06:02.000Z"),
      parentSessionUuid,
    });
    return sealEvent(
      {
        ...unsealed("proof.observed", FLIP),
        root_session_uuid: rootSessionUuid,
      },
      genesis.next,
    ).event;
  }

  it("hands a root session's fresh proof frames and its public id to the proof recorder", async () => {
    const db = fakeDb();
    wire(db);
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events = [
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("proof.observed", FLIP),
    ].map((draft) => {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      return sealed.event;
    });
    mocks.recordProofFrames.mockResolvedValue({
      written: 1,
      witnessRunIds: [],
    });
    await tachoEventsIngestHandler(batch(events), CONTEXT);
    expect(mocks.recordProofFrames).toHaveBeenCalledOnce();
    expect(mocks.recordProofFrames.mock.calls[0]?.slice(1)).toEqual([
      { orgId: CONTEXT.orgId, workspaceId: CONTEXT.workspaceId },
      RUN,
      [events[1]],
    ]);
    // An open session has no cost row yet: its seal asks for one later.
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("asks the rollup to rebuild a root session sealed before the verdict arrived", async () => {
    const db = fakeDb();
    wire(db);
    const proof = sealedSessionAndProof(db, null);
    mocks.recordProofFrames.mockResolvedValue({
      written: 1,
      witnessRunIds: [],
    });
    await tachoEventsIngestHandler(batch([proof]), CONTEXT);
    expect(mocks.recordProofFrames.mock.calls[0]?.[3]).toEqual([proof]);
    expect(mocks.sendEvent).toHaveBeenCalledWith({
      name: "cost/run.sealed",
      data: {
        runId: RUN,
        orgId: CONTEXT.orgId,
        workspaceId: CONTEXT.workspaceId,
      },
    });
  });

  it("asks the rollup to rebuild each witness run the new verdicts name, beside the sealed run", async () => {
    const db = fakeDb();
    wire(db);
    const WITNESS_RUN = "tse_fake0000000000witness";
    const proof = sealedSessionAndProof(db, null);
    mocks.recordProofFrames.mockResolvedValue({
      written: 1,
      witnessRunIds: [WITNESS_RUN],
    });
    await tachoEventsIngestHandler(batch([proof]), CONTEXT);
    expect(mocks.sendEvent.mock.calls.map(([e]) => e.data.runId)).toEqual([
      RUN,
      WITNESS_RUN,
    ]);
  });

  it("asks for no rebuild when the recorder wrote nothing (negative)", async () => {
    const db = fakeDb();
    wire(db);
    const proof = sealedSessionAndProof(db, null);
    await tachoEventsIngestHandler(batch([proof]), CONTEXT);
    expect(mocks.recordProofFrames).toHaveBeenCalledOnce();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("records a subagent's proof frame under its root session's run and rebuilds the sealed root", async () => {
    const db = fakeDb();
    wire(db);
    const ROOT_SESSION = crypto.randomUUID();
    const ROOT_RUN = "tse_fake00000000000000root";
    db.sessions.set(ROOT_SESSION, {
      id: "s0",
      publicId: ROOT_RUN,
      sessionUuid: ROOT_SESSION,
      hostId: HOST_ID,
      sealedAt: new Date("2026-09-08T10:07:00.000Z"),
      parentSessionUuid: null,
    });
    const proof = sealedSessionAndProof(db, ROOT_SESSION, ROOT_SESSION);
    mocks.recordProofFrames.mockResolvedValue({
      written: 1,
      witnessRunIds: [],
    });
    await tachoEventsIngestHandler(batch([proof]), CONTEXT);
    expect(mocks.recordProofFrames.mock.calls[0]?.slice(1)).toEqual([
      { orgId: CONTEXT.orgId, workspaceId: CONTEXT.workspaceId },
      ROOT_RUN,
      [proof],
    ]);
    expect(mocks.sendEvent).toHaveBeenCalledOnce();
    expect(mocks.sendEvent).toHaveBeenCalledWith({
      name: "cost/run.sealed",
      data: {
        runId: ROOT_RUN,
        orgId: CONTEXT.orgId,
        workspaceId: CONTEXT.workspaceId,
      },
    });
  });

  it("refuses a subagent's proof frame whose root session the workspace has not recorded (negative)", async () => {
    const db = fakeDb();
    wire(db);
    const unrecorded = crypto.randomUUID();
    const proof = sealedSessionAndProof(db, unrecorded, unrecorded);
    const err = await tachoEventsIngestHandler(batch([proof]), CONTEXT).catch(
      (e: unknown) => e,
    );
    expect(isHandlerError(err) && [err.code, err.reason]).toEqual([
      "conflict",
      "root_session_unrecorded",
    ]);
    expect(mocks.recordProofFrames).not.toHaveBeenCalled();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("never hands the recorder a frame at or below the recorded head (negative)", async () => {
    const db = fakeDb();
    wire(db);
    const proof = sealedSessionAndProof(db, null);
    const genesisAgain = sealEvent(
      unsealed("agent_start", { session_start_source: "startup" }),
      GENESIS_CURSOR,
    ).event;
    await tachoEventsIngestHandler(batch([genesisAgain, proof]), CONTEXT);
    expect(mocks.recordProofFrames.mock.calls[0]?.[3]).toEqual([proof]);
  });
});
