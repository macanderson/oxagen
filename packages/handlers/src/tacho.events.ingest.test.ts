import type { CapabilityContext } from "@oxagen/oxagen";
import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertTachoEvents: vi.fn(),
  withTenantDb: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...original, insertTachoEvents: mocks.insertTachoEvents };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { foldDelta, tachoEventsIngestHandler } from "./tacho.events.ingest";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
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

function unsealed(
  kind: UnsealedTachoEvent["kind"],
  body: Record<string, unknown>,
  source: TachoEvent["source"] = "hook",
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
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
      host_enrollment_id: HOST_PUBLIC,
    },
    context: {
      cwd: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    },
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
  sessions: Map<string, Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  controlCommands: Array<Record<string, unknown>>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
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
      },
    ],
    sessions: new Map(),
    models: [],
    files: [],
    commands: [],
    controlCommands: [
      {
        id: "c1",
        publicId: "tcm_1",
        hostId: HOST_ID,
        outcome: "pending",
        command: "message",
        payload: { text: "hello" },
        issuedAt: new Date("2026-09-08T10:00:00.000Z"),
        expiresAt: null,
      },
    ],
    updates: [],
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
          tachoSessions: { findFirst: async () => db.sessions.get(SESSION) },
          authorizationDenyGenerations: {
            findMany: async () => [
              { workspaceId: null, generation: 4 },
              { workspaceId: CONTEXT.workspaceId, generation: 2 },
            ],
          },
          tachoControlCommands: {
            findMany: async () =>
              db.controlCommands.filter((c) => c["outcome"] === "pending"),
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
              if (
                name === "control_commands" &&
                values["outcome"] === "delivered"
              ) {
                for (const command of db.controlCommands)
                  command["outcome"] = "delivered";
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
    });
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

  it("denies a batch that names another host, a missing key, or a revoked host", async () => {
    const db = fakeDb();
    wire(db);
    const events = session();
    const foreign = structuredClone(events);
    for (const event of foreign)
      event.agent.host_enrollment_id = "tch_zzzzzzzzzzzzzzzzzzzzzz";
    await expect(
      tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events: foreign,
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/another host/);
    await expect(
      tachoEventsIngestHandler(
        { schema: "tacho.batch.v1", host_enrollment_id: HOST_PUBLIC, events },
        { ...CONTEXT, apiKeyId: null },
      ),
    ).rejects.toThrow(/API key required/);
    const revoked = fakeDb();
    (revoked.hosts[0] as Record<string, unknown>)["status"] = "revoked";
    wire(revoked);
    await expect(
      tachoEventsIngestHandler(
        { schema: "tacho.batch.v1", host_enrollment_id: HOST_PUBLIC, events },
        CONTEXT,
      ),
    ).rejects.toThrow(/revoked/);
    expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
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
});
