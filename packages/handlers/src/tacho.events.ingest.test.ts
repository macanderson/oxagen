import type { CapabilityContext } from "@oxagen/oxagen";
import {
  GENESIS_CURSOR,
  type ChainCursor,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { resetColumnProbesForTests, schema } from "@oxagen/database";
import { Column, Param, SQL } from "drizzle-orm";
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
  fetchAgentRunAuthzIn: vi.fn(),
}));

vi.mock("./lib/proof", () => ({
  recordProofFrames: mocks.recordProofFrames,
}));

vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({ put: mocks.bodyPut }),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...original, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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

// The tool-RBAC half of the mandate (`resolveHostMandate`), which runs only
// for a host that names an agent principal. It reads live authority through
// the ingest transaction, and this file's fake carries the ingest tables and
// not the IAM ones. These cases are about what ingest records, so the
// snapshot is stubbed empty; the resolution itself is covered in
// `packages/iam` and the mapping in `lib/tacho-mandate.test.ts`.
vi.mock("@oxagen/iam/fetch-agent-authz", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@oxagen/iam/fetch-agent-authz")>();
  return { ...original, fetchAgentRunAuthzIn: mocks.fetchAgentRunAuthzIn };
});

vi.mock("@oxagen/billing", () => ({ recordSpend: mocks.recordSpend }));
vi.mock("./event-client", () => ({
  eventClient: { send: mocks.sendEvent },
}));

import { digestBytes } from "@oxagen/tacho";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { clearSteeringCacheForTests } from "./lib/tacho-steering";
import {
  enforcementTierOf,
  foldDelta,
  isObservedModelCall,
  tachoEventsIngestHandler,
  usageCountedEvents,
} from "./tacho.events.ingest";

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

type AgentLabel = Pick<TachoEvent["agent"], "runtime" | "harness">;
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

/**
 * The batch shape a connected app actually produces: the daemon's own chain,
 * with a gateway tool call sealed onto it.
 *
 * Mixed by construction, which is the point — the daemon's `agent_start` opens
 * the chain long before any app calls anything.
 */
function gatewayBatch(): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of [
    unsealed("agent_start", { session_start_source: "startup" }),
    unsealed(
      "tool_call",
      {
        tool_name: "query_ontology",
        tool_use_id: "toolu_gw",
        tool_status: "ok",
        tool_source: "mcp",
        mcp_server_name: "oxagen",
      },
      "hook",
      CLAUDE_CODE,
      {
        attrs: {
          "oxagen.connected_app": "claude-desktop",
          "oxagen.enforcement_tier": "gateway",
        },
      },
    ),
  ]) {
    const sealed = sealEvent(draft, cursor);
    cursor = sealed.next;
    out.push(sealed.event);
  }
  return out;
}

/**
 * The attack in the P1 finding, as a batch.
 *
 * An ORDINARY agent session — a wrapped Claude Code run on an enrolled host,
 * genesis through `agent_stop`, so it seals — with
 * `oxagen.enforcement_tier=gateway` added to one tool call. That attribute is
 * all a process holding the local OTLP bearer needs: `normalizeOtlp` keeps
 * unknown attributes verbatim, the daemon seals them onto a valid chain, and
 * the chain verifies. Nothing about the record is malformed.
 *
 * `envelopeTier` is the same claim by the other door — `agent.enforcement_tier`
 * on the envelope, which the ingest contract accepts and the seal path read.
 */
function forgedGatewaySession(
  options: { envelopeTier?: boolean } = {},
): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const draft of [
    unsealed("agent_start", { session_start_source: "startup" }),
    unsealed("turn_start", { prompt_length: 3 }),
    unsealed(
      "tool_call",
      {
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        tool_status: "ok",
        effect_kind: "command",
        tool_target: "echo hi",
      },
      "hook",
      CLAUDE_CODE,
      { attrs: { "oxagen.enforcement_tier": "gateway" } },
    ),
    unsealed("turn_end", {}),
    unsealed("agent_stop", {
      session_outcome: "completed",
      session_end_reason: "other",
      duration_ms: 900,
    }),
  ]) {
    const claimed =
      options.envelopeTier === true
        ? ({
            ...draft,
            agent: { ...draft.agent, enforcement_tier: "gateway" },
          } as UnsealedTachoEvent)
        : draft;
    const sealed = sealEvent(claimed, cursor);
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
  /** The `SET` clause of each `session_files` upsert, in order. */
  fileSets: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  controlCommands: Array<Record<string, unknown>>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  /**
   * `tacho.gateway_chains` — the control plane's own record of which of this
   * host's chains its gateway has served, one row each (#3221). Empty by
   * default, which is the honest state: no chain has been served.
   */
  /**
   * Hide the session from the read that precedes the INSERT, while leaving it
   * in `sessions` for the conflict to hit. That IS the race: `existing` is read
   * before the insert, so a row another request creates in between is invisible
   * to the `common` this batch computed.
   */
  hideSessionFromRead: boolean;
  /**
   * Raise the row's tier immediately after the read, modelling a
   * promotion-only re-send committing in between. It moves NO seq, which is
   * what makes it the case a head-only optimistic guard misses.
   */
  promoteTierOnRead: string | undefined;
  /**
   * Hide the session from the NEXT read only. The conflict path with the row
   * still visible afterwards: `existing` is undefined, the INSERT conflicts,
   * and the re-read that follows sees the row the winner left — which is how
   * the handler gets a `publicId` for a session it did not open.
   */
  hideSessionFromNextRead: boolean;
  /**
   * A concurrent batch for the same session commits between this request's read
   * and its write, advancing the row's `seq_count` to this value. One-shot:
   * applied on the next session read and then cleared, which is the interleaving
   * — the read returns values, and the row moves on under them.
   */
  advanceSeqCountOnRead: number | undefined;
  containedLaunches: Array<{ sessionUuid: string; genesisHash: string }>;
  gatewayChains: Array<{
    chainSessionUuid: string;
    lastSeenAt: Date;
    chainGenesisHash: string | null;
  }>;
  /**
   * Columns this fake database does NOT have yet, as
   * `<schema>.<table>.<column>`.
   *
   * Empty by default — the migrated steady state every other case here is
   * about. A case that fills it models the deploy-before-migrate window (#1275,
   * and nothing migrates production automatically): the node is live, the
   * migration is not, and the readiness probe is what stands between a pending
   * ALTER TABLE and an ingest path that rejects every batch.
   */
  pendingColumns: Set<string>;
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
        // No gateway call has ever been authorised for this host. The default,
        // because it is the honest one: a tier may only rise on evidence the
        // control plane holds, and by default it holds none.
        gatewayLastSeenAt: null,
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
    fileSets: [],
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
    hideSessionFromRead: false,
    promoteTierOnRead: undefined,
    hideSessionFromNextRead: false,
    advanceSeqCountOnRead: undefined,
    pendingColumns: new Set<string>(),
    gatewayChains: [],
    containedLaunches: [],
    retentionPolicy: undefined,
  };
}

/**
 * The control plane's own record that it served a gateway call for this host,
 * ON THIS CHAIN.
 *
 * `machineKeyDenial` writes both halves in one place when it authorises a call
 * presenting the host's `tacho_gateway_v1` credential: the host timestamp, and
 * a `tacho.gateway_chains` row naming the daemon chain the caller was
 * serving (upserted — one row per chain, not one per call). The helper writes both for the same reason — a fixture that set
 * only the timestamp would be describing a state the writer cannot produce.
 *
 * Without both, no batch can reach the `gateway` tier, whatever the batch
 * says.
 */
function watchedGatewayHost(
  db: FakeDb,
  at = new Date("2026-09-08T09:00:00.000Z"),
  chain = SESSION,
  // The chain's genesis hash, which the gateway states on every call and which
  // ingest compares against the session's own. Tests that care pass the real
  // hash of the batch's first event; the default is a chain whose genesis
  // nothing will match, which is the honest stand-in for "some other chain".
  chainGenesisHash: string | null = `sha256:${"c".repeat(64)}`,
): void {
  (db.hosts[0] as Record<string, unknown>)["gatewayLastSeenAt"] = at;
  db.gatewayChains.push({
    chainSessionUuid: chain,
    lastSeenAt: at,
    chainGenesisHash,
  });
}

/**
 * The control plane has served a gateway call for the chain THIS BATCH is on.
 *
 * Seeds both halves the promotion needs and takes the genesis hash from the
 * batch itself rather than inventing one, so the match is the real thing: the
 * chain row states the hash of the daemon's own first sealed event, and the
 * session row records the same hash when it opens. A test that made both up
 * would pass against a comparison of two constants.
 */
function servedChain(
  db: FakeDb,
  events: TachoEvent[],
  at = new Date("2026-09-08T09:00:00.000Z"),
): string {
  const genesis = (events[0] as TachoEvent).hash;
  watchedGatewayHost(db, at, (events[0] as TachoEvent).session_uuid, genesis);
  return genesis;
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
/**
 * The `(column, value)` pairs an equality predicate binds, in order.
 *
 * `eq(col, value)` compiles to the chunks `[Column, " = ", Param]`, and `and()`
 * nests those, so pairing a column with the next parameter recovers exactly the
 * equalities the statement will evaluate. The fixture re-evaluates them against
 * the row as it stands, which is what Postgres does — a fake that applied the
 * SET regardless would report an optimistic guard working when it was absent.
 */
function boundColumns(node: unknown): Array<[string, unknown]> {
  if (!(node instanceof SQL)) return [];
  const pairs: Array<[string, unknown]> = [];
  let pending: string | null = null;
  for (const chunk of node.queryChunks) {
    if (chunk instanceof Column) {
      pending = chunk.name.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      );
    } else if (chunk instanceof Param) {
      if (pending !== null) pairs.push([pending, chunk.value]);
      pending = null;
    } else if (chunk instanceof SQL) {
      pairs.push(...boundColumns(chunk));
      pending = null;
    }
  }
  return pairs;
}

function sessionNamed(db: FakeDb, where: unknown) {
  for (const value of boundValues(where)) {
    const row = db.sessions.get(value as string);
    if (row) return row;
  }
  return undefined;
}

/**
 * What `information_schema` says about the column a readiness probe just asked
 * about.
 *
 * The probe is the only statement this fixture's `execute` ever sees, and it
 * interpolates schema, table and column as plain strings into `sql` rather than
 * as bound `Param`s — so they are read straight off `queryChunks` and not
 * through `boundValues`, which only sees params. A statement that is not the
 * probe (three strings in that order) is answered "present", which keeps every
 * case that predates `pendingColumns` on the migrated path.
 */
function probeAnswer(
  db: FakeDb,
  query: unknown,
): Array<Record<string, number>> {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const named = chunks.filter((c): c is string => typeof c === "string");
  if (named.length !== 3) return [{ "?column?": 1 }];
  return db.pendingColumns.has(named.join(".")) ? [] : [{ "?column?": 1 }];
}

function wire(db: FakeDb): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The readiness probe asks `information_schema` before the handler
        // reads or writes any column a pending migration adds. It binds schema,
        // table and column in that order, so the fixture can answer per column
        // rather than "everything is applied": one row for present, none for
        // absent. `db.pendingColumns` is empty by default, so every existing
        // case still sees the migrated steady state.
        execute: async (query: unknown) => probeAnswer(db, query),
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
            findFirst: async (args: { where?: unknown }) => {
              if (db.hideSessionFromRead) return undefined;
              if (db.hideSessionFromNextRead) {
                db.hideSessionFromNextRead = false;
                return undefined;
              }
              const row = sessionNamed(db, args.where);
              if (!row) return undefined;
              // A read returns VALUES, not a live handle on the row — which is
              // the whole reason `existing` can be stale. Snapshotting here is
              // what lets the fixture model a concurrent commit landing
              // between the read and the write.
              const snapshot = { ...row };
              if (db.advanceSeqCountOnRead !== undefined) {
                row["seqCount"] = db.advanceSeqCountOnRead;
                db.advanceSeqCountOnRead = undefined;
              }
              if (db.promoteTierOnRead !== undefined) {
                row["enforcementTier"] = db.promoteTierOnRead;
                db.promoteTierOnRead = undefined;
              }
              return snapshot;
            },
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
          // The mandate read (`resolveHostMandate`), which the control
          // envelope every ingest answers with is built from. This fixture
          // publishes no agent version and stores no decision rules, so the
          // envelope carries the empty permission set and the observed
          // budget; `tacho-host-bundle.test.ts` covers a mandate that is not.
          agents: { findFirst: async () => undefined },
          agentVersions: { findFirst: async () => undefined },
          workspaces: { findFirst: async () => undefined },
        },
        // Two reads share `select`, told apart by the table. The steering
        // read (`readWorkspaceSteering`) counts `context_promotions` for the
        // bundle cache key and joins `context_records` to their pinned
        // versions; this fixture holds no steering, so both answer empty.
        // The other is the one grouped read `gatewayInvocationsFor` makes:
        // this host's invocations for the chains the batch names, newest per
        // chain.
        select: () => ({
          from: (table: unknown) => ({
            // Every row this fixture holds. The real statement narrows by
            // host id and by the chains the batch names; neither narrowing is
            // modelled, because `inArray` does not bind its list as a `Param`
            // and a fake that pretended to read it would be asserting its own
            // guess. The fixture holds one host's rows, and the handler looks
            // each chain up by name — so a chain nobody served is still a
            // miss, which is the property these tests are about.
            where: async () =>
              tableName(table) === "contained_launches"
                ? db.containedLaunches
                : tableName(table) === "context_promotions"
                  ? [{ ledger: 0, steering: 0 }]
                  : tableName(table) === "session_files"
                    ? // The rollup reads this session's existing rows to keep
                      // one file on one row across batches, so the fixture
                      // holds them rather than answering with another table's
                      // shape.
                      db.files.map((row) => ({
                        path: row["path"],
                        repoRelativePath: row["repoRelativePath"],
                      }))
                    : db.gatewayChains.map((row) => ({
                        chain: row.chainSessionUuid,
                        at: row.lastSeenAt,
                        genesisHash: row.chainGenesisHash,
                      })),
            leftJoin: () => ({ where: async () => [] }),
          }),
        }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            const name = tableName(table);
            // Whether the statement changed anything, which `returning()`
            // reports. A refused `setWhere` returns no rows, and the handler
            // reads that to decide whether the rest of the batch's writes are
            // this session's to make.
            let accepted = true;
            // Whether the statement INSERTED, as `xmax = 0` reports it. A
            // conflict that took the update path did not, and must not count
            // as a new session.
            let inserted = false;
            const apply = (args?: {
              setWhere?: unknown;
              set?: Record<string, unknown>;
            }): void => {
              const uuid = values["sessionUuid"] as string;
              const present =
                name === "sessions" ? db.sessions.get(uuid) : undefined;
              accepted = true;
              // `setWhere`, both halves. A seal is final, so nothing may
              // overwrite one — and a promotion may only land on the chain it
              // was derived from, which is the genesis hash the predicate
              // binds. Modelled by reading the bound values out of the
              // condition: a fixture that checked only the seal would report
              // the genesis guard working when it was absent.
              if (args?.setWhere !== undefined && present !== undefined) {
                if (
                  present["sealedAt"] !== undefined &&
                  present["sealedAt"] !== null
                ) {
                  accepted = false;
                  return;
                }
                const bound = boundValues(args.setWhere).filter(
                  (v): v is string => typeof v === "string",
                );
                if (
                  bound.length > 0 &&
                  !bound.includes(present["genesisHash"] as string)
                ) {
                  accepted = false;
                  return;
                }
              }
              if (name === "sessions") {
                inserted = present === undefined;
                if (present !== undefined) {
                  Object.assign(present, args?.set ?? {});
                } else {
                  db.sessions.set(uuid, {
                    id: "s1",
                    publicId: "tse_fake0000000000000001",
                    ...values,
                  });
                }
              }
              if (name === "session_models") db.models.push(values);
              if (name === "session_files") {
                db.files.push(values);
                if (args?.set !== undefined) db.fileSets.push(args.set);
              }
            };
            const chain = {
              // Chainable AND awaitable, like drizzle's builder: some call
              // sites await it directly and the session insert calls
              // `.returning()` on it to learn whether the guard let the
              // statement through.
              onConflictDoUpdate: (args?: {
                setWhere?: unknown;
                set?: Record<string, unknown>;
              }) => {
                apply(args);
                return Object.assign(Promise.resolve([]), {
                  returning: async () =>
                    accepted ? [{ id: "new", inserted }] : [],
                });
              },
              // Chainable AND awaitable, like `onConflictDoUpdate`. `DO
              // NOTHING` inserts only when there is no row to conflict with,
              // and `returning()` hands back a row only when it inserted one —
              // which is how the handler learns that its INSERT lost.
              onConflictDoNothing: () => {
                if (name === "session_commands") db.commands.push(values);
                if (name === "sessions") {
                  const uuid = values["sessionUuid"] as string;
                  if (db.sessions.has(uuid)) {
                    accepted = false;
                  } else {
                    accepted = true;
                    db.sessions.set(uuid, {
                      id: "s1",
                      publicId: "tse_fake0000000000000001",
                      ...values,
                    });
                  }
                }
                const rows = accepted ? [{ id: "new" }] : [];
                // Awaited WITHOUT `.returning()`, postgres-js yields no rows at
                // all — even for an insert that succeeded. Modelled, because a
                // fixture that handed back rows anyway would let a statement
                // that forgot its RETURNING read as working, which is exactly
                // how one shipped.
                return Object.assign(Promise.resolve([]), {
                  returning: async () => rows,
                });
              },
              returning: async () => (accepted ? [{ id: "new" }] : []),
            };
            return chain;
          },
        }),
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => {
            const run = async (condition?: unknown) => {
              const name = tableName(table);
              db.updates.push({ table: name, values });
              if (name === "control_commands" && values["outcome"] === "sent") {
                for (const command of db.controlCommands)
                  command["outcome"] = "sent";
              }
              if (name === "sessions") {
                const current = db.sessions.get(SESSION);
                if (!current) return [];
                // The WHERE is re-evaluated against the row as it is NOW. The
                // existing-session update carries an optimistic guard on
                // `seq_count`, and a fixture that ignored it would pass
                // whether or not the guard were there.
                for (const [column, value] of boundColumns(condition)) {
                  if (current[column] === undefined) continue;
                  if (current[column] !== value) return [];
                }
                Object.assign(current, values);
                return [{ id: current["id"] ?? "s1" }];
              }
              return [];
            };
            return {
              // Chainable AND awaitable: the statement runs once, and
              // `.returning()` hands back the same answer rather than
              // re-executing it.
              where: (condition?: unknown) => {
                const result = run(condition);
                return Object.assign(result, { returning: () => result });
              },
            };
          },
        }),
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSteeringCacheForTests();
  // The probe cache is per process and keeps a positive answer for the life of
  // it, so without this a case about a PENDING column would read the previous
  // case's "applied" and pass whether or not the gate existed.
  resetColumnProbesForTests();
  mocks.insertTachoEvents.mockResolvedValue(undefined);
  mocks.selectTachoEvents.mockResolvedValue([]);
  mocks.bodyPut.mockImplementation(async (input: { digest: string }) => ({
    ref: `evb:v1:test:${input.digest.slice(7)}`,
  }));
  mocks.unlockOnboardingGate.mockResolvedValue(false);
  mocks.recordSpend.mockResolvedValue(undefined);
  mocks.sendEvent.mockResolvedValue(undefined);
  mocks.recordProofFrames.mockResolvedValue({ written: 0, witnessRunIds: [] });
  mocks.fetchAgentRunAuthzIn.mockResolvedValue({
    roles: [],
    roleGrants: [],
    grants: [],
    policies: [],
  });
});

describe("ingest_tacho_events", () => {
  it("stores the latest session host facts from fresh frames and keeps them on retry", async () => {
    const db = fakeDb();
    wire(db);
    const first = sealEvent(
      unsealed("agent_start", {}, "hook", CLAUDE_CODE, {
        host: { os_type: "linux", os_version: "6.12", host_arch: "x64" },
      }),
      GENESIS_CURSOR,
    );
    const second = sealEvent(
      unsealed("turn_start", {}, "hook", CLAUDE_CODE, {
        host: { os_type: "linux", os_version: "6.13" },
      }),
      first.next,
    );
    await tachoEventsIngestHandler(batch([first.event, second.event]), CONTEXT);
    const snapshot = {
      platform: "linux",
      osVersion: "6.13",
      arch: null,
      recordedAt: second.event.ts,
      eventHash: second.event.hash,
    };
    expect(db.sessions.get(SESSION)?.["machineSnapshot"]).toEqual(snapshot);
    await tachoEventsIngestHandler(batch([first.event, second.event]), CONTEXT);
    expect(db.sessions.get(SESSION)?.["machineSnapshot"]).toEqual(snapshot);
    const third = sealEvent(unsealed("turn_start", {}), second.next);
    await tachoEventsIngestHandler(batch([third.event]), CONTEXT);
    expect(db.sessions.get(SESSION)?.["machineSnapshot"]).toEqual(snapshot);
  });

  it("keeps ingest working while the machine snapshot column is pending", async () => {
    const db = fakeDb();
    db.pendingColumns.add("tacho.sessions.machine_snapshot");
    wire(db);
    const event = sealEvent(
      unsealed("agent_start", {}, "hook", CLAUDE_CODE, {
        host: { os_type: "linux" },
      }),
      GENESIS_CURSOR,
    );
    await tachoEventsIngestHandler(batch([event.event]), CONTEXT);
    expect(db.sessions.get(SESSION)).not.toHaveProperty("machineSnapshot");
    db.pendingColumns.clear();
    const next = sealEvent(
      unsealed("turn_start", {}, "hook", CLAUDE_CODE, {
        host: { os_type: "linux" },
      }),
      event.next,
    );
    await tachoEventsIngestHandler(batch([next.event]), CONTEXT);
    expect(db.sessions.get(SESSION)?.["machineSnapshot"]).toMatchObject({
      platform: "linux",
      eventHash: next.event.hash,
    });
  });

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
      // The extension names the language on its own. The place does not:
      // this session reports a `cwd` and no worktree, and a path made
      // relative to a working directory is not repo-relative.
      language: undefined,
      repoRelativePath: undefined,
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

  it("places a touched file in its repository and names its language", async () => {
    const db = fakeDb();
    wire(db);
    // The same session, reported from a worktree rather than a bare cwd.
    const context = {
      cwd: "/home/dev/proj/packages/tacho",
      worktree_path: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    };
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed(
        "agent_start",
        { session_start_source: "startup", tools_available: ["Write"] },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "file_io",
        {
          tool_name: "Write",
          tool_use_id: "toolu_1",
          effect_kind: "file_write",
          tool_target: "/home/dev/proj/packages/tacho/src/envelope.ts",
          effect_id: "eff_1",
          tool_input_bytes: 40,
        },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "file_io",
        {
          tool_name: "Write",
          tool_use_id: "toolu_2",
          effect_kind: "file_write",
          // Outside the worktree, so it keeps its absolute path and gets no
          // repo-relative form. It is still a file the run touched.
          tool_target: "/etc/hosts",
          effect_id: "eff_2",
          tool_input_bytes: 8,
        },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }

    const output = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );
    expect(output.accepted).toBe(events.length);

    const inside = db.files.find(
      (file) =>
        file["path"] === "/home/dev/proj/packages/tacho/src/envelope.ts",
    );
    expect(inside).toMatchObject({
      repoRelativePath: "packages/tacho/src/envelope.ts",
      language: "typescript",
    });
    const outside = db.files.find((file) => file["path"] === "/etc/hosts");
    expect(outside).toMatchObject({ repoRelativePath: undefined });
  });

  /**
   * A session whose worktree was reconciled `times` over, every frame
   * reporting the same three paths. The counts are cumulative against HEAD,
   * so the same numbers repeated are the same state observed again, not more
   * work done.
   */
  function reconciledSession(
    times: number,
    editedCounts: { lines_added: number; lines_removed: number } = {
      lines_added: 12,
      lines_removed: 3,
    },
  ): TachoEvent[] {
    const context = {
      cwd: "/home/dev/proj",
      worktree_path: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    };
    const observed = [
      {
        path: "/home/dev/proj/src/edited.ts",
        repo_relative_path: "src/edited.ts",
        status: "modified",
        ...editedCounts,
      },
      {
        // Untracked, so git reports it in `status` and in no diff at all.
        path: "/home/dev/proj/src/created.ts",
        repo_relative_path: "src/created.ts",
        status: "added",
        lines_added: 0,
        lines_removed: 0,
      },
      {
        path: "/home/dev/proj/src/gone.ts",
        repo_relative_path: "src/gone.ts",
        status: "deleted",
        lines_added: 0,
        lines_removed: 9,
      },
    ];
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    const drafts = [
      unsealed(
        "agent_start",
        { session_start_source: "startup", tools_available: ["Write"] },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      ...Array.from({ length: times }, () =>
        unsealed(
          "oxagen:worktree_reconciled",
          {
            observed_changes: observed,
            observed_changes_total: observed.length,
            observed_changes_truncated: false,
          },
          "collector",
          CLAUDE_CODE,
          { context },
        ),
      ),
    ];
    for (const draft of drafts) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    return events;
  }

  it("fills the line counts from what git observed, not from a tool", async () => {
    const db = fakeDb();
    wire(db);
    const events = reconciledSession(1);
    const output = await tachoEventsIngestHandler(batch(events), CONTEXT);
    expect(output.accepted).toBe(events.length);

    // A path no tool announced still has a row: this is the write the
    // attested record never sees.
    const edited = db.files.find(
      (file) => file["path"] === "/home/dev/proj/src/edited.ts",
    );
    expect(edited).toMatchObject({
      repoRelativePath: "src/edited.ts",
      language: "typescript",
      linesAdded: 12,
      linesRemoved: 3,
      observedStatus: "modified",
      // Nothing announced it, so no tool-call counter moved.
      writes: 0,
      edits: 0,
      deletes: 0,
    });
    const created = db.files.find(
      (file) => file["path"] === "/home/dev/proj/src/created.ts",
    );
    // An untracked file is in no diff, so git offers no line count for it and
    // none is invented.
    expect(created).toMatchObject({ observedStatus: "added", linesAdded: 0 });
    const gone = db.files.find(
      (file) => file["path"] === "/home/dev/proj/src/gone.ts",
    );
    expect(gone).toMatchObject({ observedStatus: "deleted", linesRemoved: 9 });
    // The three statuses are told apart, which the counters alone cannot do.
    expect([
      edited?.["observedStatus"],
      created?.["observedStatus"],
      gone?.["observedStatus"],
    ]).toEqual(["modified", "added", "deleted"]);
    // digest_before and digest_after stay empty: git hands out blob hashes,
    // and the column expects the sha256 the rest of the record uses.
    expect(edited).not.toHaveProperty("digestBefore");
    expect(edited).not.toHaveProperty("digestAfter");
  });

  it("assigns the observed line counts rather than accumulating them", async () => {
    const db = fakeDb();
    wire(db);
    // Two frames in one batch, then the whole thing again in a second batch:
    // four reports of the same twelve lines.
    await tachoEventsIngestHandler(batch(reconciledSession(2)), CONTEXT);
    await tachoEventsIngestHandler(batch(reconciledSession(2)), CONTEXT);

    const dialect = new PgDialect();
    const sets = db.fileSets.filter(
      (set) => set["observedStatus"] !== undefined,
    );
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      for (const column of ["linesAdded", "linesRemoved"]) {
        // A plain number, not an expression over the stored one: a second
        // batch reporting the same measurement must not double it, and the
        // pair must stay the pair git reported. Taking the larger of each
        // column on its own was the earlier reading of "do not double", and
        // it let 12/3 followed by 2/10 settle at 12/10, which no
        // reconciliation ever saw.
        expect(typeof set[column], column).toBe("number");
      }
      // The counters on the same row DO accumulate, which is the contrast
      // this assertion exists to hold.
      expect(dialect.sqlToQuery(set["writes"] as SQL).sql).toContain(" + ");
      expect(["modified", "added", "deleted"]).toContain(set["observedStatus"]);
    }
  });

  it("leaves an observed count alone when a later batch carries no observation", async () => {
    const db = fakeDb();
    wire(db);
    await tachoEventsIngestHandler(batch(reconciledSession(1)), CONTEXT);
    db.fileSets.length = 0;
    // A plain tool frame on the same path, with nothing observed.
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("file_io", {
        tool_name: "Write",
        tool_use_id: "toolu_9",
        effect_kind: "file_write",
        tool_target: "/home/dev/proj/src/edited.ts",
        effect_id: "eff_9",
        tool_input_bytes: 10,
      }),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    await tachoEventsIngestHandler(batch(events), CONTEXT);
    for (const set of db.fileSets) {
      expect(set).not.toHaveProperty("linesAdded");
      expect(set).not.toHaveProperty("linesRemoved");
      expect(set).not.toHaveProperty("observedStatus");
    }
  });

  it("merges the attested and observed forms of one path into one row", async () => {
    // A tool reports a relative target and git reports the same file
    // absolutely. Keyed on those raw strings the file became two rows, one
    // carrying the writes and the other the observed status and line counts,
    // and the Run page showed it twice with half the truth on each.
    const db = fakeDb();
    wire(db);
    const context = {
      cwd: "/home/dev/proj",
      worktree_path: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    };
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed("agent_start", {}, "hook", CLAUDE_CODE, { context }),
      unsealed(
        "file_io",
        {
          tool_name: "Write",
          tool_use_id: "toolu_1",
          effect_kind: "file_write",
          // Relative, as a tool commonly reports it.
          tool_target: "src/a.ts",
          effect_id: "eff_1",
          tool_input_bytes: 12,
        },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "oxagen:worktree_reconciled",
        {
          observed_changes: [
            {
              // Absolute, as git reports it.
              path: "/home/dev/proj/src/a.ts",
              repo_relative_path: "src/a.ts",
              status: "modified",
              lines_added: 9,
              lines_removed: 2,
            },
          ],
          observed_changes_total: 1,
          observed_changes_truncated: false,
        },
        "collector",
        CLAUDE_CODE,
        { context },
      ),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }

    const output = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );
    expect(output.accepted).toBe(events.length);

    expect(db.files).toHaveLength(1);
    expect(db.files[0]).toMatchObject({
      // The absolute path wins, since it is the one a person can act on.
      path: "/home/dev/proj/src/a.ts",
      repoRelativePath: "src/a.ts",
      writes: 1,
      observedStatus: "modified",
      linesAdded: 9,
      linesRemoved: 2,
    });
  });

  it("keeps one file on one row when the reconciliation lands in a later batch", async () => {
    // The within-batch normalization only helps when both frames travel
    // together, which is what a test constructs and the rarer case in
    // practice. The reconciliation is asynchronous, so it usually arrives a
    // batch or more after the tool frame, and the conflict key is
    // (session_id, path). Without matching the rows already stored, the run
    // still ends up with two rows for one file.
    const db = fakeDb();
    wire(db);
    const context = {
      cwd: "/home/dev/proj",
      worktree_path: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    };
    const send = async (drafts: UnsealedTachoEvent[], from: ChainCursor) => {
      let cursor = from;
      const events: TachoEvent[] = [];
      for (const draft of drafts) {
        const sealed = sealEvent(draft, cursor);
        cursor = sealed.next;
        events.push(sealed.event);
      }
      const output = await tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events,
          daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
        },
        CONTEXT,
      );
      expect(output.accepted).toBe(events.length);
      return cursor;
    };

    // Batch one: the tool announces a relative path.
    const after = await send(
      [
        unsealed("agent_start", {}, "hook", CLAUDE_CODE, { context }),
        unsealed(
          "file_io",
          {
            tool_name: "Write",
            tool_use_id: "toolu_1",
            effect_kind: "file_write",
            tool_target: "src/a.ts",
            effect_id: "eff_1",
            tool_input_bytes: 12,
          },
          "hook",
          CLAUDE_CODE,
          { context },
        ),
      ],
      GENESIS_CURSOR,
    );
    expect(db.files).toHaveLength(1);

    // Batch two: git reports the same file absolutely.
    await send(
      [
        unsealed(
          "oxagen:worktree_reconciled",
          {
            observed_changes: [
              {
                path: "/home/dev/proj/src/a.ts",
                repo_relative_path: "src/a.ts",
                status: "modified",
                lines_added: 9,
                lines_removed: 2,
              },
            ],
            observed_changes_total: 1,
            observed_changes_truncated: false,
          },
          "collector",
          CLAUDE_CODE,
          { context },
        ),
      ],
      after,
    );

    // Two upserts, both naming the path the first row already stored, so the
    // conflict fires and the run has one file rather than two.
    expect(db.files).toHaveLength(2);
    expect(db.files[1]?.["path"]).toBe(db.files[0]?.["path"]);
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
    // The mandate's authority read runs through the ingest transaction, not
    // a second one of its own: the first argument is this fixture's tx.
    expect(mocks.fetchAgentRunAuthzIn).toHaveBeenCalledTimes(1);
    const [authzTx, authzArgs] = mocks.fetchAgentRunAuthzIn.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(authzTx).toHaveProperty("query");
    expect(authzArgs).toMatchObject({
      orgId: CONTEXT.orgId,
      workspaceId: CONTEXT.workspaceId,
      agentPrincipalId: "agent-principal-uuid",
      humanPrincipalId: null,
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

  it("refuses the batch as backpressure when the store is out of memory (#3662)", async () => {
    const db = fakeDb();
    wire(db);
    // The refusal from the 2026-09-21 production logs, in the shape the
    // ClickHouse client parses one into. Before this, it left the route as a
    // bare 500, which the host reads as a server fault and retries into
    // immediately instead of waiting for the read holding the memory to end.
    // (`storeOverloadedFrom` is proven against the client's own parser in
    // packages/telemetry/src/clickhouse.test.ts.)
    mocks.insertTachoEvents.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Memory limit (total) exceeded: would use 1.66 GiB (attempt to " +
            "allocate chunk of 4363399 bytes), maximum: 1.50 GiB. " +
            "OvercommitTracker decision: Query was selected to stop by " +
            "OvercommitTracker.",
        ),
        { code: "241", type: "MEMORY_LIMIT_EXCEEDED" },
      ),
    );
    const refusal = await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: session(),
      },
      CONTEXT,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refusal as { code?: string }).code).toBe("store_overloaded");
    expect(
      (refusal as { retryAfterSeconds?: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
    // The refusal is a condition to wait out, not a fault to page on.
    expect(mocks.loggerError).not.toHaveBeenCalled();
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
      commits: 0,
      pushes: 0,
      pullRequests: 0,
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
      // A repository effect is counted off its `effect_kind`, not off the
      // frame kind: a pull request opened from the shell is a `command`
      // frame and one opened over MCP is a `network` frame, and both are
      // the same act.
      seal(unsealed("command", { effect_kind: "git_commit" })),
      seal(unsealed("command", { effect_kind: "git_push" })),
      seal(unsealed("command", { effect_kind: "pr_open" })),
      seal(unsealed("network", { effect_kind: "pr_open" })),
      seal(unsealed("command", { effect_kind: "command" })),
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
      networkCalls: 2,
      commandsRun: 4,
      commits: 1,
      pushes: 1,
      pullRequests: 2,
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
        expect(Object.keys(row)).toEqual(["chainVerified"]);
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
 * `gateway` files the call the way the daemon does — the collector attribute
 * on the tool call — not by declaring a tier on the envelope. The envelope
 * field decides nothing any more (discussion_r4036718127, P1), so a test that
 * set it would be asserting against a tier the handler no longer reads. The
 * caller must also put the matching observation on the host row; a batch alone
 * cannot make a session gateway, which is the whole point.
 */
function sessionWithContent(tier?: "gateway"): TachoEvent[] {
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
    if (tier === "gateway" && draft.kind === "tool_call")
      (draft as UnsealedTachoEvent).attrs = {
        "oxagen.enforcement_tier": "gateway",
      };
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

/**
 * The deploy-before-migrate window, for the two columns this branch adds.
 *
 * `deploy-node` ships on merge and nothing migrates production automatically —
 * the manual `db-migrate.yml` is the only path from a committed migration to
 * prod — so the node runs new code against the old schema for as long as it
 * takes someone to run the workflow. Every accepted batch reaches the session
 * counter UPDATE and the file rollup, so an unguarded reference to
 * `tacho.sessions.pushes` or `tacho.session_files.observed_status` does not
 * degrade one field: 42703 aborts the transaction and the whole batch is
 * rejected, for the whole window (discussion_r4051911079).
 *
 * The case that matters is therefore this one, not the migrated steady state
 * the rest of the suite covers: the batch is accepted, and everything the
 * schema CAN hold is still written.
 */
describe("ingestion survives a pending migration", () => {
  const PENDING = [
    "tacho.sessions.pushes",
    "tacho.session_files.observed_status",
  ];

  function pushingSession(): TachoEvent[] {
    const context = {
      cwd: "/home/dev/proj",
      worktree_path: "/home/dev/proj",
      model: "claude-haiku-4-5-20251001",
      permission_mode: "default",
    };
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      unsealed(
        "agent_start",
        { session_start_source: "startup" },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "file_io",
        {
          tool_name: "Write",
          tool_use_id: "toolu_1",
          effect_kind: "file_write",
          tool_target: "/home/dev/proj/src/edited.ts",
          effect_id: "eff_1",
          tool_input_bytes: 40,
        },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      // The push is the frame whose counter has nowhere to go yet.
      unsealed(
        "command",
        { effect_kind: "git_push", tool_target: "git push origin main" },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "command",
        { effect_kind: "git_commit", tool_target: "git commit -m x" },
        "hook",
        CLAUDE_CODE,
        { context },
      ),
      unsealed(
        "oxagen:worktree_reconciled",
        {
          observed_changes: [
            {
              path: "/home/dev/proj/src/edited.ts",
              repo_relative_path: "src/edited.ts",
              status: "modified",
              lines_added: 12,
              lines_removed: 3,
            },
          ],
          observed_changes_total: 1,
          observed_changes_truncated: false,
        },
        "collector",
        CLAUDE_CODE,
        { context },
      ),
    ]) {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      events.push(sealed.event);
    }
    return events;
  }

  it("accepts the batch and writes every column the schema does have", async () => {
    const db = fakeDb();
    for (const column of PENDING) db.pendingColumns.add(column);
    wire(db);
    const events = pushingSession();

    const output = await tachoEventsIngestHandler(batch(events), CONTEXT);
    // The whole point: nothing is rejected over a column the deploy is ahead
    // of.
    expect(output.accepted).toBe(events.length);

    const sessionUpdate = db.updates.find((u) => u.table === "sessions");
    expect(sessionUpdate).toBeDefined();
    // The one counter with nowhere to go is omitted from the SET, not written
    // as null and not written as an expression over a column that does not
    // exist.
    expect(sessionUpdate?.values).not.toHaveProperty("pushes");
    // Everything beside it still lands. `commits` is the control: it is the
    // counter next to `pushes` in the same object, on a column the table has
    // had since it was created, and a gate that took out the whole increment
    // would drop this too.
    const dialect = new PgDialect();
    for (const column of ["commits", "commandsRun", "filesWritten"]) {
      expect(sessionUpdate?.values, column).toHaveProperty(column);
      expect(
        dialect.sqlToQuery(sessionUpdate?.values[column] as SQL).sql,
      ).toContain(" + ");
    }

    // The file row is written with its attested counters and its line counts;
    // only the observed verdict is held back.
    const file = db.files.find(
      (row) => row["path"] === "/home/dev/proj/src/edited.ts",
    );
    expect(file).toBeDefined();
    expect(file).not.toHaveProperty("observedStatus");
    expect(file).toMatchObject({
      repoRelativePath: "src/edited.ts",
      linesAdded: 12,
      linesRemoved: 3,
      writes: 1,
    });
  });

  it("writes both columns again once the migration lands, without a restart", async () => {
    // No clock advance or cache reset: the very next accepted batch must
    // observe a column added since the previous negative probe.
    const pending = fakeDb();
    for (const column of PENDING) pending.pendingColumns.add(column);
    wire(pending);
    await tachoEventsIngestHandler(batch(pushingSession()), CONTEXT);
    expect(
      pending.updates.find((u) => u.table === "sessions")?.values,
    ).not.toHaveProperty("pushes");

    const migrated = fakeDb();
    wire(migrated);
    await tachoEventsIngestHandler(batch(pushingSession()), CONTEXT);
    expect(
      migrated.updates.find((u) => u.table === "sessions")?.values,
    ).toHaveProperty("pushes");
    expect(
      migrated.files.find(
        (row) => row["path"] === "/home/dev/proj/src/edited.ts",
      ),
    ).toMatchObject({ observedStatus: "modified" });
  });
});

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

  it("refuses as backpressure when the store is out of memory for the re-send's read (#3662)", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = sessionWithContent();
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    // The read that resolves a re-sent frame's stored body reaches the same
    // node the append does, and only a re-send sends it, so it sits on the
    // retry path of the very failure this refusal exists for.
    mocks.selectTachoEvents.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Memory limit (total) exceeded: would use 1.66 GiB, maximum: 1.50 GiB.",
        ),
        { code: "241", type: "MEMORY_LIMIT_EXCEEDED" },
      ),
    );
    const refusal = await tachoEventsIngestHandler(batch(events), CONTEXT).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refusal as { code?: string }).code).toBe("store_overloaded");
    // The append never ran, so the second batch is still the host's to ship.
    expect(mocks.insertTachoEvents).toHaveBeenCalledOnce();
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

  it("seals fork on a gateway-tier session whose tool call kept its result body", async () => {
    const db = fakeDb();
    const events = sessionWithContent("gateway");
    const genesisHash = servedChain(db, events);
    // The chain exists before the batch that seals it. A gateway tier is only
    // ever reached on a session the server already has a `createdAt` for —
    // genesis cannot be promoted, because there is no lifetime to bound the
    // observation against and a forged first batch naming a real chain id
    // would satisfy the match as well as the real one. That is also the real
    // shape: a daemon chain opens when the daemon starts and flushes many
    // times before it ends.
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      genesisHash,
      // A chain that is open but has recorded nothing, which is what a daemon
      // chain looks like between its genesis and its first flush. Both fields
      // matter: without `seqCount` every event reads as re-sent, so nothing is
      // fresh and nothing seals; without `lastHash` the chain-continuity check
      // compares the batch's first `prev_hash` against `undefined` and reports
      // a break, which drops the replay grade.
      seqCount: 0,
      lastHash: null,
      // An unverified row can never become verified — `ok` is forced false for
      // one — so a fixture that omits this grades every batch as a chain
      // break, whatever the batch actually contains.
      chainVerified: true,
    });
    wire(db);
    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(db.sessions.get(SESSION)).toMatchObject({
      replayGrade: "fork",
      completenessGaps: [],
    });
  });

  it("refuses and retries an INSERT that lost to a row it never read", async () => {
    // The conflict path writes nothing now. It used to apply a `common`
    // computed from `existing` — the read that PRECEDED the insert, which says
    // nothing about the row the statement is hitting — and every attempt to
    // make that safe added another predicate and another way to be half right:
    // doubled counters, a head advanced past an `agent_stop` whose seal was
    // dropped, a tier promoted onto a forged genesis.
    //
    // So a conflict is refused and the whole attempt rolls back. The retry
    // reads the row and takes the existing-session path, which has the real
    // values and its own guards — at most one retry, because a conflict means
    // the row exists.
    const db = fakeDb();
    const events = sessionWithContent("gateway");
    servedChain(db, events);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      sealedAt: null,
      genesisHash: (events[0] as TachoEvent).hash,
    });
    // Invisible to the read that precedes the INSERT: that is the race.
    db.hideSessionFromRead = true;
    wire(db);

    await expect(
      tachoEventsIngestHandler(batch(events), CONTEXT),
    ).rejects.toMatchObject({ code: "conflict" });

    // Nothing of this batch landed on the winner's row…
    const row = db.sessions.get(SESSION);
    expect(row?.["enforcementTier"]).toBe("observe");
    expect(row?.["replayGrade"]).toBeUndefined();
    expect(row?.["lastHash"]).toBeUndefined();
    // …and nothing reached ClickHouse, so the retry is not a partial re-run.
    expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
    // Nor was it counted as a new session for the host.
    expect(
      db.updates.find(
        (u) => u.table === "hosts" && "sessionsCount" in u.values,
      ),
    ).toBeUndefined();
  });

  it("refuses an update whose tier moved under the read", async () => {
    // The head is not the only tier-relevant state. A promotion-only re-send —
    // same frames, already recorded, so no new seq — raises
    // `enforcement_tier` and leaves `seq_count` exactly where this batch read
    // it. A concurrent terminal batch that derived `observe` then matches the
    // head and writes an observe-derived `replayGrade` onto a row that is now
    // `gateway`: the sealed tier and the signed grade disagree, for good.
    const db = fakeDb();
    const events = sessionWithContent("gateway");
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      // As this request reads it.
      enforcementTier: "observe",
      sealedAt: null,
      seqCount: 0,
      lastHash: null,
      chainVerified: true,
      genesisHash: (events[0] as TachoEvent).hash,
    });
    // …and the promotion commits immediately after this request's read, which
    // moves no seq at all.
    db.promoteTierOnRead = "gateway";
    wire(db);

    // Refused AND retried: a stale read is transient, so the batch has to come
    // back rather than be acknowledged and dropped from the daemon's WAL.
    await expect(
      tachoEventsIngestHandler(
        batch(events, [bodyFor(events[1] as TachoEvent)]),
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    const row = db.sessions.get(SESSION);
    expect(row?.["enforcementTier"]).toBe("gateway");
    // Nothing from the stale fold landed — in particular not a grade computed
    // from `observe`.
    expect(row?.["replayGrade"]).toBeUndefined();
    expect(row?.["sealedAt"] ?? null).toBeNull();
    // …and nothing reached ClickHouse, so the retry is not a partial re-run.
    expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
  });

  it("refuses a batch whose session advanced under the read its frames were folded against", async () => {
    // The existing-session path claimed `accepted` was "always true — it
    // targets a row it read". It targets a row it read A MOMENT AGO, under no
    // lock. `fresh` is every event at or past `existing.seqCount`, so when a
    // concurrent batch for the same session commits in between, both
    // transactions fold the SAME frames and every counter is applied twice —
    // and a row the first one sealed is written again by the second, whose
    // `terminalPatch` was computed against an unsealed read.
    //
    // Not adversarial: the daemon re-sends a batch whose response it did not
    // see, so a retry overlapping an in-flight original is the ordinary way
    // two requests carry identical frames.
    const db = fakeDb();
    const events = session();
    db.sessions.set(SESSION, {
      id: "s1",
      publicId: "tse_s1",
      sessionUuid: SESSION,
      seqCount: 3,
      lastHash: events[2]?.hash,
      chainVerified: true,
      hostId: HOST_ID,
    });
    // The concurrent winner commits between this request's read and its write.
    db.advanceSeqCountOnRead = events.length;
    wire(db);

    // Refused AND retried. A stale read is transient — the same batch succeeds
    // against a fresh one — so acknowledging it would let the shipper delete
    // frames that were never recorded. `conflict` maps to 409, which is
    // neither `ControlUnreachable` nor the 400/422 the shipper quarantines on,
    // so it takes the "keep the batch, back off" branch.
    await expect(
      tachoEventsIngestHandler(
        {
          schema: "tacho.batch.v1",
          host_enrollment_id: HOST_PUBLIC,
          events: events.slice(3),
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    // The winner's head stands, unwritten by the loser.
    expect(db.sessions.get(SESSION)?.["seqCount"]).toBe(events.length);
    // The loser's frames are not written — folding them again would count the
    // winner's own increments a second time.
    expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
  });

  it("grades a genesis-and-seal batch with the tier it actually writes", async () => {
    // The row and the seal must come from ONE derivation. They did not: the
    // caller computed the tier from `existing?.genesisHash`, which is null for
    // a session being created, so the seal graded `observe`; `genesisRow`
    // computed it again from the batch's own first hash and wrote `gateway`.
    // The sealed row then carried a gateway tier with an observe-derived
    // grade, and a sealed session is never regraded — exports and attestations
    // keep that pair for good.
    //
    // A daemon chain that opens and seals in one batch is the shape that
    // reaches it: no existing row, and the seal computed in the same pass.
    const db = fakeDb();
    const events = sessionWithContent("gateway");
    servedChain(db, events);
    wire(db);

    await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );

    const row = db.sessions.get(SESSION);
    expect(row?.["enforcementTier"]).toBe("gateway");
    // `fork` is what a gateway tier with a retained tool body grades to.
    // `inspect` is what the observe-derived seal produced, which is the bug.
    expect(row?.["replayGrade"]).toBe("fork");
    expect(row?.["sealedAt"]).toBeDefined();
  });

  it("seals below fork on a gateway-tier session whose tool call kept no result body (negative)", async () => {
    const db = fakeDb();
    const events = sessionWithContent("gateway");
    const genesisHash = servedChain(db, events);
    // The chain exists before the batch that seals it. A gateway tier is only
    // ever reached on a session the server already has a `createdAt` for —
    // genesis cannot be promoted, because there is no lifetime to bound the
    // observation against and a forged first batch naming a real chain id
    // would satisfy the match as well as the real one. That is also the real
    // shape: a daemon chain opens when the daemon starts and flushes many
    // times before it ends.
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      genesisHash,
      // A chain that is open but has recorded nothing, which is what a daemon
      // chain looks like between its genesis and its first flush. Both fields
      // matter: without `seqCount` every event reads as re-sent, so nothing is
      // fresh and nothing seals; without `lastHash` the chain-continuity check
      // compares the batch's first `prev_hash` against `undefined` and reports
      // a break, which drops the replay grade.
      seqCount: 0,
      lastHash: null,
      // An unverified row can never become verified — `ok` is forced false for
      // one — so a fixture that omits this grades every batch as a chain
      // break, whatever the batch actually contains.
      chainVerified: true,
    });
    wire(db);
    await tachoEventsIngestHandler(batch(events), CONTEXT);
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

  it("names a live run from where it is working, before anything seals it", async () => {
    // `summarize_run` refuses a run that is still live and refuses a
    // `digest_only` workspace, so without this the list shows a uuid for
    // exactly the runs someone is watching.
    const db = fakeDb();
    wire(db);
    let cursor: ChainCursor = GENESIS_CURSOR;
    const events: TachoEvent[] = [];
    for (const draft of [
      {
        ...unsealed("agent_start", { session_start_source: "startup" }),
        context: {
          cwd: "/home/dev/oxagen",
          git_branch: "agent/pensive-volta",
        },
      } as UnsealedTachoEvent,
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
      title: "oxagen · agent/pensive-volta",
    });
  });

  it("refuses a body whose class the workspace did not authorise", async () => {
    // `content_exact` says exact bytes MAY be kept. The classes say which.
    // A workspace that authorised the model exchange and nothing else must
    // not have its tool output stored because the mode alone looked open.
    const db = fakeDb();
    db.retentionPolicy = {
      mode: "content_exact",
      retainedContentClasses: ["model_call"],
    };
    wire(db);
    const events = sessionWithContent();
    const output = await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([
      {
        event_id_idem: (events[1] as TachoEvent).event_id_idem,
        reason: "retention_class_excluded",
      },
    ]);
    expect(mocks.bodyPut).not.toHaveBeenCalled();
  });

  it("keeps a body whose class the workspace did authorise", async () => {
    const db = fakeDb();
    db.retentionPolicy = {
      mode: "content_exact",
      retainedContentClasses: ["tool_call"],
    };
    wire(db);
    const events = sessionWithContent();
    const output = await tachoEventsIngestHandler(
      batch(events, [bodyFor(events[1] as TachoEvent)]),
      CONTEXT,
    );
    expect(output.body_rejections).toEqual([]);
    expect(mocks.bodyPut).toHaveBeenCalledTimes(1);
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

describe("enforcementTierOf", () => {
  const AT = new Date("2026-09-08T10:00:00.000Z");
  /** The chain's genesis hash, stated by the gateway and recorded on the row. */
  const GENESIS = `sha256:${"a".repeat(64)}`;
  /** A `tacho.gateway_chains` row that proves which chain it belongs to. */
  const served = (at: Date = AT, genesisHash: string | null = GENESIS) => ({
    at,
    genesisHash,
  });
  /** A host whose gateway credential the control plane has seen authorised. */
  const watched = (mode: string) => ({ mode, gatewayLastSeenAt: AT });
  /** A host that has never had a gateway call authorised. */
  const unwatched = (mode: string) => ({ mode, gatewayLastSeenAt: null });

  it("labels a chain the control plane served a gateway call for", () => {
    // recordGatewayCall seals the call onto the daemon's own tachod-* chain
    // and the host recorder sets no identity tier, so these calls used to be
    // filed under the HOST's mode -- the wrong enforcement semantics for the
    // one kind of call Oxagen saw directly (#3161, discussion_r4033641270).
    expect(
      enforcementTierOf(served(), watched("observe"), true, true, GENESIS),
    ).toBe("gateway");
  });

  it("refuses a chain the control plane has no record of serving", () => {
    // THE finding (#3221). The host really did serve a gateway call — the
    // observation on the host row is real — but this chain is not one the
    // gateway credential was ever authenticated for. Under the old rule the
    // batch answered that question itself, by carrying
    // `oxagen.enforcement_tier`, so any submitter could point a real
    // observation at any session. Now the answer comes from
    // `tacho.gateway_chains` and a chain nobody's gateway served has no
    // row there, whatever the batch says about it.
    expect(
      enforcementTierOf(null, watched("observe"), true, true, GENESIS),
    ).toBe("observe");
    expect(
      enforcementTierOf(null, watched("enforce"), true, true, GENESIS),
    ).toBe("harness");
  });

  it("refuses an invocation on a host with no observation at all", () => {
    // The belt. The two records are written by the same function but by
    // separate statements, and a deployment can be mid-migration on one and
    // not the other; disagreement is not evidence.
    expect(
      enforcementTierOf(served(), unwatched("observe"), true, true, GENESIS),
    ).toBe("observe");
  });

  it("does not order gateway use behind the chain's first ingest", () => {
    // There used to be a fourth condition: the call must not predate the
    // session's `createdAt`. It was wrong in the direction that does not
    // announce itself. The control plane records a gateway call while HANDLING
    // it and the daemon seals the event after the call returns, so a chain
    // whose first gateway call precedes its first ingest arrives with its
    // record already written — and was then refused at genesis and on every
    // batch after, permanently if the first batch sealed it.
    //
    // A record bound to this exact chain by its genesis hash is about this
    // chain whenever it was written, so there is nothing left for an ordering
    // to decide.
    expect(
      enforcementTierOf(served(), watched("observe"), true, true, GENESIS),
    ).toBe("gateway");
  });

  it("refuses a chain that does not verify", () => {
    // The genesis hash is a hash in the batch, and a forger who cannot produce
    // the daemon's first event can still WRITE its hash into an event of their
    // own. Only `verifyChain` rejects an event whose hash is not the hash of
    // its contents, so an unverified chain proves nothing about the value the
    // match turns on.
    expect(
      enforcementTierOf(served(), watched("observe"), false, true, GENESIS),
    ).toBe("observe");
  });

  it("falls back to the host mode when nothing says otherwise", () => {
    expect(
      enforcementTierOf(null, unwatched("observe"), true, true, GENESIS),
    ).toBe("observe");
    expect(
      enforcementTierOf(null, unwatched("enforce"), true, true, GENESIS),
    ).toBe("harness");
  });

  it("refuses gateway when there is nowhere to record the evidence", () => {
    // Migration 20260917140000 adds the host column and the session column in
    // two statements, so a run that fails between them leaves a database that
    // can DERIVE the tier and cannot RECORD what justifies it
    // (discussion_r4040750815). The tier is monotonic, so a session sealed in
    // that window would carry `gateway` with a null observation for good.
    //
    // Same invocation and same watched host as the case that returns
    // `gateway` above — only the evidence column differs, which is what makes
    // this discriminating.
    expect(
      enforcementTierOf(served(), watched("enforce"), true, false, GENESIS),
    ).toBe("harness");
    expect(
      enforcementTierOf(served(), watched("observe"), true, false, GENESIS),
    ).toBe("observe");
  });
});

describe("gateway attribution reaches the chain that carries the call", () => {
  // The finding this closes (discussion_r4034318913): computing the tier at
  // insert never reached the row. A gateway call joins the daemon's long-lived
  // tachod-* chain, whose genesis was written when the daemon started, so the
  // handler takes its existing-session branch and applies only `common`.
  it("promotes an EXISTING session's tier on the update path", async () => {
    const db = fakeDb();
    const events = gatewayBatch();
    const genesisHash = servedChain(db, events);
    // The chain already exists, opened before any connected app called anything.
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      genesisHash,
      // A chain that is open but has recorded nothing, which is what a daemon
      // chain looks like between its genesis and its first flush. Both fields
      // matter: without `seqCount` every event reads as re-sent, so nothing is
      // fresh and nothing seals; without `lastHash` the chain-continuity check
      // compares the batch's first `prev_hash` against `undefined` and reports
      // a break, which drops the replay grade.
      seqCount: 0,
      lastHash: null,
      // An unverified row can never become verified — `ok` is forced false for
      // one — so a fixture that omits this grades every batch as a chain
      // break, whatever the batch actually contains.
      chainVerified: true,
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    const sessionUpdate = db.updates.find(
      (u) => u.table === "sessions" && "enforcementTier" in u.values,
    );
    expect(sessionUpdate?.values["enforcementTier"]).toBe("gateway");
    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("gateway");
  });

  it.each(["matching", "mismatch", "no-traffic", "pending-migration"])(
    "derives containment from a separate launch receipt: %s",
    async (caseName) => {
      const db = fakeDb();
      const events = gatewayBatch();
      const genesis = events[0]!.hash;
      db.containedLaunches.push({
        sessionUuid: SESSION,
        genesisHash: caseName === "mismatch" ? "f".repeat(64) : genesis,
      });
      if (caseName !== "no-traffic") servedChain(db, events);
      if (caseName === "pending-migration")
        db.pendingColumns.add("tacho.contained_launches.genesis_hash");
      wire(db);
      await tachoEventsIngestHandler(
        { schema: "tacho.batch.v1", host_enrollment_id: HOST_PUBLIC, events },
        CONTEXT,
      );
      expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe(
        caseName === "matching"
          ? "contained"
          : caseName === "no-traffic"
            ? "observe"
            : "gateway",
      );
      if (caseName === "matching")
        expect(db.sessions.get(SESSION)?.["gatewayObservedAt"]).toBeInstanceOf(
          Date,
        );
    },
  );

  it("refuses a recorded session that has no genesis hash of its own", async () => {
    // A row that EXISTS and recorded no genesis is answered with nothing, not
    // with a hash taken off the batch. The two are different questions: the
    // recorded value is what the row can be checked against afterwards, and a
    // batch's re-sent seq-0 event is never written back to it — so promoting on
    // one would leave a `gateway` row whose `genesis_hash` is null, citing
    // evidence nobody can re-derive.
    //
    // Reachable rather than hypothetical: every session row created before this
    // feature carries a null `genesis_hash` and a true `chain_verified`, and
    // whether it promoted would otherwise depend on whether some later batch
    // happened to re-send seq 0.
    //
    // Discriminating against "promotes an EXISTING session's tier" directly
    // above: same host, same chain record, same batch, and the row's own
    // genesis hash is the only difference.
    const db = fakeDb();
    const events = gatewayBatch();
    servedChain(db, events);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      // The whole of the difference.
      genesisHash: null,
      seqCount: 0,
      lastHash: null,
      chainVerified: true,
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values["enforcementTier"]).not.toBe("gateway");
    }
  });

  it("leaves an existing wrapped-agent chain at its own tier", async () => {
    // No gateway event, so nothing to promote and nothing to demote.
    const db = fakeDb();
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "harness",
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: session(),
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values).not.toHaveProperty("enforcementTier");
    }
    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("harness");
  });
});

// ---------------------------------------------------------------------------
// The enforcement tier is not a field the submitter may set
// ---------------------------------------------------------------------------
//
// discussion_r4036596... (P1). A process that can submit OTLP for an enrolled
// host — and the harness receives the local bearer, so that set is wider than
// it looks — adds `oxagen.enforcement_tier=gateway` to an ordinary record.
// normalizeOtlp keeps unknown attributes verbatim (otel.ts header: "Every
// attribute is either promoted to a typed member or kept verbatim in attrs"),
// the daemon seals them into a valid chain, and ingest then promoted an
// existing observe session to gateway. Exports sign that tier and replay
// grading trusts it.
//
// The seal is doing its job and proves nothing about this: it shows the record
// was not altered AFTER collection, not that the value was true when it went
// in. A valid chain over a false input is byte-for-byte a valid chain.
//
// The whole value of the tier is that it separates what the platform enforced
// from what the agent claims. A tier the agent can set is not a weaker version
// of that separation, it is the absence of one with a signature on top.
describe("a submitted enforcement tier is a claim, never the tier", () => {
  /** The host has never had a gateway call authorised. `fakeDb` is already
   * this, spelled out here because it is the load-bearing fact: with no
   * server observation there is nothing for any batch to correlate to. */
  function hostWithNoGatewayObservation(db: FakeDb): void {
    (db.hosts[0] as Record<string, unknown>)["gatewayLastSeenAt"] = null;
  }

  it("does not promote an existing observe session on a client-set attribute", async () => {
    const db = fakeDb();
    hostWithNoGatewayObservation(db);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: forgedGatewaySession(),
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    // The session keeps the tier the control plane derived for it.
    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    // And no statement tried to raise it.
    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values["enforcementTier"]).not.toBe("gateway");
    }
  });

  it("does not let a submitted attribute decide a NEW session either", async () => {
    const db = fakeDb();
    hostWithNoGatewayObservation(db);
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: forgedGatewaySession(),
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
  });

  it("does not let a submitted ENVELOPE tier decide one", async () => {
    // The same hole by the other door. `enforcementTierOf` read
    // events[0].agent.enforcement_tier, which is as client-supplied as the
    // attribute — the ingest contract accepts whatever the batch carries.
    // Genesis must land on the host's server-owned mode.
    const db = fakeDb();
    hostWithNoGatewayObservation(db);
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: forgedGatewaySession({ envelopeTier: true }),
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
  });

  it("does not sign the claimed tier into the seal the export carries", async () => {
    // What makes this an escalation rather than a mislabel: the seal's replay
    // grade is computed from the tier and travels in the export bundle and the
    // attestation. `observe` grades `inspect`; `gateway` with no gaps grades
    // `retry`/`fork` (evidence/replay-grade.ts). A client-set tier that
    // reached the seal would be signed as if Oxagen had enforced the calls.
    const db = fakeDb();
    hostWithNoGatewayObservation(db);
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events: forgedGatewaySession({ envelopeTier: true }),
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    const row = db.sessions.get(SESSION);
    expect(row?.["sealedAt"]).toBeDefined();
    expect(row?.["enforcementTier"]).toBe("observe");
    expect(row?.["replayGrade"]).toBe("inspect");
  });

  it("still files a real gateway call, on the host the server watched serve one", async () => {
    // The fix must not buy safety by labelling nothing. With the control
    // plane's own record of this chain — its name AND its genesis hash — the
    // daemon's chain is gateway.
    const db = fakeDb();
    const events = gatewayBatch();
    const genesisHash = servedChain(db, events);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      genesisHash,
      // A chain that is open but has recorded nothing, which is what a daemon
      // chain looks like between its genesis and its first flush. Both fields
      // matter: without `seqCount` every event reads as re-sent, so nothing is
      // fresh and nothing seals; without `lastHash` the chain-continuity check
      // compares the batch's first `prev_hash` against `undefined` and reports
      // a break, which drops the replay grade.
      seqCount: 0,
      lastHash: null,
      // An unverified row can never become verified — `ok` is forced false for
      // one — so a fixture that omits this grades every batch as a chain
      // break, whatever the batch actually contains.
      chainVerified: true,
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("gateway");
    // And the rise points at what raised it. A tier that moves after the fact
    // has to be answerable for itself.
    expect(db.sessions.get(SESSION)?.["gatewayObservedAt"]).toBeInstanceOf(
      Date,
    );
  });

  it("never re-tiers a SEALED session, even on a real observation", async () => {
    // The seal signed a replay grade computed from the tier. A value that moves
    // underneath a signature is the escalation rather than the mislabel, so a
    // sealed session's tier is final whatever a later batch — or a later
    // gateway call on the same host — would otherwise derive.
    const db = fakeDb();
    const events = gatewayBatch();
    // Everything the promotion needs is satisfied — name, genesis hash and
    // lifetime — so the SEAL is what refuses it, which is the point here.
    const genesisHash = servedChain(db, events);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: new Date("2026-09-08T09:30:00.000Z"),
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values).not.toHaveProperty("enforcementTier");
    }
  });

  it("refuses a forged batch on a host that HAS served a real gateway call", async () => {
    // #3221, and the case every test above this one missed. The earlier fix
    // required a server observation, which bounded the attack to hosts that
    // genuinely use the gateway — but once a host had served ONE legitimate
    // call, the observation was a single reusable timestamp with no session on
    // it, and the batch chose which session it landed on by carrying
    // `oxagen.enforcement_tier`. A holder of the host's control-plane key
    // could point real evidence at any chain.
    //
    // Discriminating by construction: the host's observation is real, the
    // gateway invocation is real, and the ONLY thing wrong is that the
    // invocation names a different chain than the batch does. Against the old
    // `carriesGatewayCall` correlation this batch promotes; against the server
    // record it cannot.
    const db = fakeDb();
    const events = gatewayBatch();
    // A real record for a DIFFERENT chain: the gateway served `tachod-real`
    // and this batch is on `SESSION`, so neither the name nor the genesis
    // hash matches.
    watchedGatewayHost(db, new Date("2026-09-08T09:00:00.000Z"), "tachod-real");
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      // The forger's own genesis: this session was opened by a chain that is
      // not the one the gateway served, so its first event — and therefore its
      // genesis hash — is a different one.
      genesisHash: `sha256:${"f".repeat(64)}`,
      // A chain that is open but has recorded nothing, which is what a daemon
      // chain looks like between its genesis and its first flush. Both fields
      // matter: without `seqCount` every event reads as re-sent, so nothing is
      // fresh and nothing seals; without `lastHash` the chain-continuity check
      // compares the batch's first `prev_hash` against `undefined` and reports
      // a break, which drops the replay grade.
      seqCount: 0,
      lastHash: null,
      // An unverified row can never become verified — `ok` is forced false for
      // one — so a fixture that omits this grades every batch as a chain
      // break, whatever the batch actually contains.
      chainVerified: true,
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values["enforcementTier"]).not.toBe("gateway");
    }
  });

  it("refuses a CONTINUATION of a forged chain that stole a real chain's name", async () => {
    // The attack the genesis rule only delayed. The forger opens the session
    // first with a chain of its own, so the row's `createdAt` is theirs; then a
    // genuine gateway call on the real chain advances `lastSeenAt` past it, and
    // they submit a continuation. The chain name matches, the host observation
    // is real, the lifetime bound is satisfied — every check but one.
    //
    // The one is the genesis hash. Their chain begins with their own first
    // event, so its hash is not the one the gateway stated, and producing a
    // different chain with the same genesis hash is a preimage attack.
    //
    // Discriminating against "promotes an EXISTING session's tier": identical
    // in every respect except whose genesis the session row records.
    const db = fakeDb();
    const events = gatewayBatch();
    servedChain(db, events);
    db.sessions.set(SESSION, {
      id: "s1",
      sessionUuid: SESSION,
      hostId: HOST_ID,
      enforcementTier: "observe",
      // Written by the forger's own genesis batch, before the real call.
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
      sealedAt: null,
      genesisHash: `sha256:${"e".repeat(64)}`,
      seqCount: 0,
      lastHash: null,
      chainVerified: true,
    });
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    for (const update of db.updates.filter((u) => u.table === "sessions")) {
      expect(update.values["enforcementTier"]).not.toBe("gateway");
    }
  });

  it("promotes the genesis batch of a chain the gateway really served", async () => {
    // The chain's first gateway call can precede its first ingest: the control
    // plane records the call while HANDLING it, and the daemon seals the
    // corresponding event only after the call returns. So a legitimate chain
    // routinely arrives with its record already written, and refusing at
    // genesis sent it to `observe` — permanently, if that first batch sealed it.
    //
    // Safe because the match is the genesis HASH, not the name: a forged first
    // batch has its own genesis and fails it, which the sibling cases assert.
    const db = fakeDb();
    const events = gatewayBatch();
    servedChain(db, events);
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("gateway");
    // …and it points at the call that raised it.
    expect(db.sessions.get(SESSION)?.["gatewayObservedAt"]).toBeInstanceOf(
      Date,
    );
  });

  it("refuses a session INVENTED by the forged batch", async () => {
    // The unconditional half of the same hole. `genesisRow` passes no
    // lifetime, because nothing predates a session being opened by this very
    // batch — so a newly invented chain sailed past the "observation does not
    // predate the session" bound with nothing to stop it. It is stopped now by
    // the correlation rather than by the bound: an invented chain has no
    // invocation row.
    const db = fakeDb();
    const events = gatewayBatch();
    watchedGatewayHost(db, new Date("2026-09-08T09:00:00.000Z"), "tachod-real");
    wire(db);

    await tachoEventsIngestHandler(
      {
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST_PUBLIC,
        events,
        daemon: { version: "2.1.1", hooks_ok: true, spool_depth: 0 },
      },
      CONTEXT,
    );

    expect(db.sessions.get(SESSION)?.["enforcementTier"]).toBe("observe");
    expect(db.sessions.get(SESSION)?.["gatewayObservedAt"]).toBe(null);
  });
});

/**
 * Observed metering (ADR-094). A session routed through the host's loopback
 * model proxy reports each model call twice: the proxy's observed frame, then
 * the harness's own telemetry. The observed one counts and the other does not.
 */
describe("observed metering from the model proxy", () => {
  const OBSERVED_AT = "2026-09-08T10:06:04.000Z";
  const observedCall = (body: Record<string, unknown> = {}) =>
    unsealed(
      "llm_call",
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 2000,
        cache_creation_1h_tokens: 40,
        thinking_tokens: 9,
        cost_usd_micros: 11_100,
        cost_basis: "observed",
        api_duration_ms: 800,
        ...body,
      },
      "collector",
      CLAUDE_CODE,
      {
        fidelity: "proxy",
        ts: OBSERVED_AT,
        attrs: { "oxagen.metering": "observed" },
      },
    );
  const selfReported = (source: TachoEvent["source"] = "otel_log") =>
    unsealed(
      "llm_call",
      {
        model: "claude-sonnet-5",
        input_tokens: 990,
        output_tokens: 480,
        thinking_tokens: 8,
        cost_usd_micros: 9_000,
      },
      source,
    );
  function chain(drafts: UnsealedTachoEvent[]): TachoEvent[] {
    let cursor: ChainCursor = GENESIS_CURSOR;
    return drafts.map((draft) => {
      const sealed = sealEvent(draft, cursor);
      cursor = sealed.next;
      return sealed.event;
    });
  }
  const start = () =>
    unsealed("agent_start", { session_start_source: "startup" });

  it("recognises an observed frame by all three marks, not by the attribute alone", () => {
    const [real, forged, otel] = chain([
      observedCall(),
      // What a process holding the local OTLP bearer can produce: the
      // attribute, on a record the collector sealed as ordinary telemetry.
      unsealed("llm_call", {}, "otel_log", CLAUDE_CODE, {
        attrs: { "oxagen.metering": "observed" },
      }),
      selfReported(),
    ]) as [TachoEvent, TachoEvent, TachoEvent];
    expect(isObservedModelCall(real)).toBe(true);
    expect(isObservedModelCall(forged)).toBe(false);
    expect(isObservedModelCall(otel)).toBe(false);
  });

  it("drops self-reported usage once a session is observed, and only then", () => {
    const events = chain([
      start(),
      selfReported(),
      observedCall(),
      selfReported(),
      selfReported("transcript"),
      unsealed("turn_start", {}),
    ]);
    // The call before the first observed frame was never routed: it counts.
    expect(usageCountedEvents(events, false).map((e) => e.seq)).toEqual([
      0, 1, 2, 5,
    ]);
    // A later batch of a session already observed drops every one of them.
    expect(usageCountedEvents(events, true).map((e) => e.seq)).toEqual([
      0, 2, 5,
    ]);
    // A session that bypassed the proxy is counted as it always was.
    const bypassed = chain([
      start(),
      selfReported(),
      selfReported("transcript"),
    ]);
    expect(usageCountedEvents(bypassed, false)).toEqual(bypassed);
  });

  it("counts a call once whichever source saw it first, and prices a transcript-only call", () => {
    const zero = () => {
      const delta = {} as Parameters<typeof foldDelta>[0];
      for (const key of [
        "numModelCalls",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "cacheCreation5mTokens",
        "cacheCreation1hTokens",
        "thinkingTokens",
        "webSearchRequests",
        "webFetchRequests",
        "totalCostMicros",
      ] as const)
        delta[key] = 0;
      return delta;
    };
    const usage = {
      model: "claude-opus-5",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 4,
    };
    const split = { ...usage, cache_creation_1h_tokens: 4, thinking_tokens: 6 };
    const stamped = (first: string) => ({
      attrs: { "oxagen.llm_call_duplicate_of": first },
    });

    // OTel first, transcript second (stamped): tokens once, split from the transcript.
    const otelFirst = zero();
    const [a, b] = chain([
      unsealed("llm_call", usage, "otel_log"),
      unsealed(
        "llm_call",
        split,
        "transcript",
        CLAUDE_CODE,
        stamped("otel_log"),
      ),
    ]) as [TachoEvent, TachoEvent];
    foldDelta(otelFirst, a);
    foldDelta(otelFirst, b);
    expect(otelFirst).toMatchObject({
      numModelCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation1hTokens: 4,
      thinkingTokens: 6,
    });

    // Transcript first, OTel second (stamped): the same totals.
    const transcriptFirst = zero();
    const [c, d] = chain([
      unsealed("llm_call", split, "transcript"),
      unsealed(
        "llm_call",
        usage,
        "otel_log",
        CLAUDE_CODE,
        stamped("transcript"),
      ),
    ]) as [TachoEvent, TachoEvent];
    foldDelta(transcriptFirst, c);
    foldDelta(transcriptFirst, d);
    expect(transcriptFirst).toMatchObject({
      numModelCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation1hTokens: 4,
      thinkingTokens: 6,
    });

    // A transcript continuation block (usage stripped, stamped transcript) adds nothing.
    const continuation = zero();
    const [e] = chain([
      unsealed(
        "llm_call",
        { model: "claude-opus-5" },
        "transcript",
        CLAUDE_CODE,
        stamped("transcript"),
      ),
    ]) as [TachoEvent];
    foldDelta(continuation, e);
    expect(continuation).toMatchObject({ numModelCalls: 0, inputTokens: 0 });
  });

  it("counts the observed frame's own classes, which the OTel view does not carry", () => {
    const delta = {} as Parameters<typeof foldDelta>[0];
    for (const key of [
      "numModelCalls",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "cacheCreation5mTokens",
      "cacheCreation1hTokens",
      "thinkingTokens",
      "webSearchRequests",
      "webFetchRequests",
      "totalCostMicros",
    ] as const)
      delta[key] = 0;
    const [observed] = chain([observedCall()]) as [TachoEvent];
    foldDelta(delta, observed);
    expect(delta).toMatchObject({
      numModelCalls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreation1hTokens: 40,
      thinkingTokens: 9,
      totalCostMicros: 11_100,
    });
  });

  it("computes gateway from a routed model call on a verified chain, and from nothing less", () => {
    const host = { mode: "enforce", gatewayLastSeenAt: null };
    expect(enforcementTierOf(null, host, true, true, null, true)).toBe(
      "gateway",
    );
    // The base URL was written and the run went around the proxy: no frame.
    expect(enforcementTierOf(null, host, true, true, null, false)).toBe(
      "harness",
    );
    expect(enforcementTierOf(null, host, true, true, null)).toBe("harness");
    // A chain that does not verify proves nothing about the frames in it.
    expect(enforcementTierOf(null, host, false, true, null, true)).toBe(
      "harness",
    );
    // Nowhere to record the evidence yet: the tier is not assigned.
    expect(enforcementTierOf(null, host, true, false, null, true)).toBe(
      "harness",
    );
  });

  it("counts a routed session once, files it under gateway, and records what the tier stands on", async () => {
    const db = fakeDb();
    (db.hosts[0] as Record<string, unknown>)["mode"] = "enforce";
    wire(db);
    const events = chain([
      start(),
      observedCall(),
      selfReported(),
      selfReported("transcript"),
    ]);
    await tachoEventsIngestHandler(batch(events), CONTEXT);

    expect(db.sessions.get(SESSION)).toMatchObject({
      enforcementTier: "gateway",
      gatewayObservedAt: new Date(OBSERVED_AT),
      costBasis: "observed",
      chainVerified: true,
    });
    expect(db.models).toHaveLength(1);
    expect(db.models[0]).toMatchObject({
      model: "claude-sonnet-5",
      provider: "anthropic",
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
      thinkingTokens: 9,
      costMicros: 11_100,
    });
    const increments = db.updates.find(
      (u) => u.table === "sessions" && u.values["inputTokens"] !== undefined,
    );
    const dialect = new PgDialect();
    const param = (key: string) =>
      dialect.sqlToQuery(increments?.values[key] as SQL).params;
    expect(param("numModelCalls")).toEqual([1]);
    expect(param("inputTokens")).toEqual([1000]);
    expect(param("totalCostMicros")).toEqual([11_100]);
  });

  it("keeps dropping self-reported usage in a later batch of the same session", async () => {
    const db = fakeDb();
    wire(db);
    const events = chain([start(), observedCall(), selfReported()]);
    await tachoEventsIngestHandler(batch(events.slice(0, 2)), CONTEXT);
    const row = db.sessions.get(SESSION) as Record<string, unknown>;
    Object.assign(row, {
      seqCount: 2,
      lastHash: (events[1] as TachoEvent).hash,
      chainVerified: true,
    });
    db.updates.length = 0;
    db.models.length = 0;
    await tachoEventsIngestHandler(batch(events.slice(2)), CONTEXT);
    expect(db.models).toHaveLength(0);
    const update = db.updates.find((u) => u.table === "sessions");
    const dialect = new PgDialect();
    expect(
      dialect.sqlToQuery(update?.values["inputTokens"] as SQL).params,
    ).toEqual([0]);
    expect(
      dialect.sqlToQuery(update?.values["numModelCalls"] as SQL).params,
    ).toEqual([0]);
  });
});
