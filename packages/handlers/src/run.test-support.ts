// In-memory stores for the run handler tests. Each fake applies the same
// tenant fence, ordering, cursor and page semantics as the Postgres query it
// stands in for, so a test proves paging and scoping behaviour rather than the
// shape of a canned reply.
import type { CapabilityContext } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import type {
  AttemptEventReadRecord,
  RunSummary,
  SubagentChainRow,
} from "@oxagen/run-ledger";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { NO_BODY } from "@oxagen/run-ledger";
import {
  IN_APP_AGENT_SURFACES,
  type RunItem,
} from "@oxagen/oxagen/contracts/run.list";
import {
  type LedgerEventRollup,
  type LedgerRunRow,
  type LedgerSeal,
  type PageQuery,
  type ReadRunRollups,
  type RunCost,
  type RunQueries,
  type RunScope,
  type TachoSessionColumns,
  type TachoSessionRow,
} from "./run.list";

export const SCOPE: RunScope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
export const OTHER_WORKSPACE: RunScope = {
  orgId: SCOPE.orgId,
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e02",
};

export function ctx(scope: RunScope = SCOPE): CapabilityContext {
  return {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    userId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
    apiKeyId: null,
    requestId: "req_1",
    surface: "api",
    messageId: null,
  };
}

/** The user an API key in these tests was created by. */
export const KEY_CREATOR = "0192d4a8-7c1e-7a00-8000-0000000c7ea7";

/** An API-key call in `scope`: no signed-in user, the key's id. */
export function keyCtx(scope: RunScope = SCOPE): CapabilityContext {
  return {
    ...ctx(scope),
    userId: null,
    apiKeyId: "0192d4a8-7c1e-7a00-8000-0000000a91e1",
    surface: "mcp",
  };
}

/**
 * A `withTenantDb` transaction double that answers the role gate's queries
 * (`resolveActingUserId` and `assertOrgRole` in @oxagen/iam): the API key's
 * creator (`keyCreator`, null for a key with none), the acting user's
 * principal and one org-role assignment. `null` is a user with no org role.
 * Every other read the run handlers make goes through injected deps, so a
 * test file mocks `@oxagen/database` with this and nothing else.
 */
export function roleTx(
  roleName: string | null,
  keyCreator: string | null = KEY_CREATOR,
) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys)
      return keyCreator ? [{ createdById: keyCreator }] : [];
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table in the role double");
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
}

const sameScope = (a: RunScope, b: RunScope) =>
  a.orgId === b.orgId && a.workspaceId === b.workspaceId;

export type LedgerFixture = LedgerRunRow & {
  scope: RunScope;
  specVersion: number;
  /** `agent_runs.surface`; the page query excludes the in-app agent's two. */
  surface?: string;
  rollup?: LedgerEventRollup;
  seal?: LedgerSeal | null;
  /** The run's `cost.run_totals` row; absent when the rollup has not covered it. */
  cost?: RunCost | null;
  /**
   * The run's seal as that row recorded it; null for a row rebuilt while the
   * run was open. Defaults to the run's own seal: a row rolled up after it.
   */
  rollupSealedAt?: Date | null;
  /** The verdict on that row; absent when no witness reported on the run. */
  verdict?: RunItem["verdict"];
  /** The worker run this run witnessed; absent for any other run. */
  witnessFor?: string;
};

/** A graded seal for a ledger fixture; `over` narrows the grade or the gaps. */
export function seal(
  runId: string,
  over: Partial<LedgerSeal> = {},
): LedgerSeal {
  return {
    runId,
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    sealedAt: new Date("2026-09-11T10:05:00.000Z"),
    replayGrade: "view",
    completenessGaps: [],
    finalRunSeq: "3",
    eventCount: 3,
    merkleRoot: `sha256:${"f".repeat(64)}`,
    archiveSegmentRef: "evidence/o/w/segments/a/f.ndjson.zst",
    enforcementTier: "harness",
    terminalStatus: "completed",
    finalEventDigest: `sha256:${"e".repeat(64)}`,
    eventStreamDigest: `sha256:${"d".repeat(64)}`,
    ...over,
  };
}

export type TachoFixture = TachoSessionRow & {
  scope: RunScope;
  /** A subagent chain: never a root session. */
  child?: boolean;
  /** The run's `cost.run_totals` row; absent when the rollup has not covered it. */
  cost?: RunCost | null;
  /** As on a ledger fixture: the seal the row recorded, the run's own by default. */
  rollupSealedAt?: Date | null;
  /** The verdict on that row; absent when no witness reported on the run. */
  verdict?: RunItem["verdict"];
  /** The worker run this run witnessed; absent for any other run. */
  witnessFor?: string;
};

export function ledgerRun(
  over: Partial<LedgerFixture> & { publicId: string; runId: string },
): LedgerFixture {
  const { publicId, runId, ...rest } = over;
  return {
    scope: SCOPE,
    specVersion: 2,
    run: {
      runId,
      publicId,
      status: "completed",
      createdAt: new Date("2026-09-11T10:00:00.000Z"),
      startedAt: new Date("2026-09-11T10:00:01.000Z"),
      name: null,
      summary: null,
      summaryGeneratedAt: null,
      summaryModel: null,
    },
    identity: {
      orgNamespace: "acme",
      workspaceNamespace: "core",
      agentSlug: "reviewer",
      operatorPublicId: "prn_0123456789abcdefghjkmn",
      operatorKind: "human",
      operatorUserName: "Marcus Bell",
      goal: "review the PR",
    },
    ...rest,
  };
}

export function tachoSession(
  over: Omit<Partial<TachoFixture>, "session"> & {
    publicId: string;
    session?: Partial<TachoSessionColumns>;
  },
): TachoFixture {
  const { publicId, session, ...rest } = over;
  return {
    scope: SCOPE,
    session: {
      id: "0192d4a8-7c1e-7000-8000-00000000c0de",
      publicId,
      sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c0de",
      agentKey: "acme.core.cc-laptop",
      outcome: "completed",
      numTurns: 2,
      numModelCalls: 3,
      numToolCalls: 4,
      seqCount: 207,
      startedAt: new Date("2026-09-11T09:00:00.000Z"),
      sealedAt: new Date("2026-09-11T09:05:00.000Z"),
      modelInitial: "claude-haiku-4-5-20251001",
      modelFinal: "claude-sonnet-5",
      replayGrade: null,
      completenessGaps: [],
      enforcementTier: "observe",
      finalHash: `sha256:${"a".repeat(64)}`,
      name: null,
      summary: null,
      summaryGeneratedAt: null,
      summaryModel: null,
      harness: "Claude Code",
      harnessVersion: "2.1.0",
      runtime: "claude-code",
      ...session,
    },
    operatorPublicId: "prn_0123456789abcdefghjkmn",
    operatorKind: "human",
    operatorUserName: "Marcus Bell",
    host: {
      hostname: "mac-studio.local",
      platform: "darwin",
      osVersion: "15.6",
      arch: "arm64",
      nodeVersion: "v24.4.0",
    },
    ...rest,
  };
}

/** The row shape `tachoPage` and `tachoSession` answer, from a fixture. */
function tachoRowOf(row: TachoFixture): TachoSessionRow {
  return {
    session: row.session,
    operatorPublicId: row.operatorPublicId,
    operatorKind: row.operatorKind,
    operatorUserName: row.operatorUserName,
    host: row.host,
  };
}

type Ordered = { at: number; id: string };

/** Newest first, ties on public id descending, as the Postgres ORDER BY. */
function newestFirst(a: Ordered, b: Ordered): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function pageOf<T extends Ordered>(rows: T[], q: PageQuery): T[] {
  const cursorAt = q.cursor ? Date.parse(q.cursor.at) : null;
  return rows
    .filter(
      (r) =>
        cursorAt === null ||
        r.at < cursorAt ||
        (r.at === cursorAt && q.cursor !== null && r.id < q.cursor.id),
    )
    .sort(newestFirst)
    .slice(0, q.limit + 1);
}

export type MemoryStores = {
  queries: RunQueries;
  readRunRollups: ReadRunRollups;
  readWitnessFor: (scope: RunScope, runId: string) => Promise<string | null>;
  /** Every `readRunRollups` call, so a test can assert what a page read. */
  rollupCalls: (readonly string[])[];
};

/** A page leaves a witness run out when the query asks it to. */
const listed =
  (q: PageQuery) =>
  (r: { witnessFor?: string }): boolean =>
    !(q.withoutWitnessRuns && r.witnessFor);

export function memoryStores(
  ledger: readonly LedgerFixture[],
  tacho: readonly TachoFixture[],
): MemoryStores {
  const rollupCalls: (readonly string[])[] = [];
  const inScope = (scope: RunScope) => ({
    ledger: ledger.filter((r) => sameScope(r.scope, scope)),
    tacho: tacho.filter((r) => sameScope(r.scope, scope)),
  });
  return {
    rollupCalls,
    queries: {
      ledgerPage: (scope, q) =>
        Promise.resolve(
          pageOf(
            inScope(scope)
              .ledger.filter(
                (r) =>
                  r.specVersion === 2 &&
                  !(IN_APP_AGENT_SURFACES as readonly string[]).includes(
                    r.surface ?? "external",
                  ),
              )
              .filter(listed(q))
              .map((r) => ({
                at: (r.run.startedAt ?? r.run.createdAt).getTime(),
                id: r.run.publicId,
                row: r,
              })),
            q,
          ).map(({ row }) => ({ run: row.run, identity: row.identity })),
        ),
      ledgerIdentity: (scope, runId) => {
        const row = inScope(scope).ledger.find(
          (r) => r.run.runId === runId && r.specVersion === 2,
        );
        return Promise.resolve(
          row ? { run: row.run, identity: row.identity } : null,
        );
      },
      ledgerRollups: (scope, runIds) =>
        Promise.resolve(
          new Map(
            inScope(scope)
              .ledger.filter((r) => runIds.includes(r.run.runId) && r.rollup)
              .map((r) => [r.run.runId, r.rollup as LedgerEventRollup]),
          ),
        ),
      ledgerSeals: (scope, runIds) =>
        Promise.resolve(
          new Map(
            inScope(scope)
              .ledger.filter((r) => runIds.includes(r.run.runId) && r.seal)
              .map((r) => [r.run.runId, r.seal as LedgerSeal]),
          ),
        ),
      tachoPage: (scope, q) =>
        Promise.resolve(
          pageOf(
            inScope(scope)
              .tacho.filter((r) => !r.child)
              .filter(listed(q))
              .map((r) => ({
                at: r.session.startedAt.getTime(),
                id: r.session.publicId,
                row: r,
              })),
            q,
          ).map(({ row }) => tachoRowOf(row)),
        ),
      tachoSession: (scope, publicId) => {
        const row = inScope(scope).tacho.find(
          (r) => r.session.publicId === publicId && !r.child,
        );
        return Promise.resolve(row ? tachoRowOf(row) : null);
      },
    },
    readRunRollups: (scope, runIds) => {
      rollupCalls.push(runIds);
      const rows = [
        ...inScope(scope).ledger.map(
          (r) => [r.run.publicId, r, r.seal?.sealedAt ?? null] as const,
        ),
        ...inScope(scope).tacho.map(
          (r) => [r.session.publicId, r, r.session.sealedAt] as const,
        ),
      ];
      return Promise.resolve(
        new Map(
          rows.flatMap(([id, r, sealedAt]) =>
            runIds.includes(id) && (r.cost || r.verdict)
              ? [
                  [
                    id,
                    {
                      cost: r.cost ?? null,
                      verdict: r.verdict ?? null,
                      sealedAt:
                        r.rollupSealedAt === undefined
                          ? sealedAt
                          : r.rollupSealedAt,
                    },
                  ] as const,
                ]
              : [],
          ),
        ),
      );
    },
    readWitnessFor: (scope, runId) =>
      Promise.resolve(
        [
          ...inScope(scope).ledger.map((r) => [r.run.publicId, r] as const),
          ...inScope(scope).tacho.map((r) => [r.session.publicId, r] as const),
        ].find(([id]) => id === runId)?.[1].witnessFor ?? null,
      ),
  };
}

export function rollupCostRow(over: Partial<RunCost> = {}): RunCost {
  return {
    costMicros: 12_500n,
    currency: "USD",
    costBasis: "gateway_observed",
    ...over,
  };
}

export function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
    publicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
    surface: "external",
    specVersion: 2,
    status: "completed",
    result: null,
    error: null,
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: new Date("2026-09-11T10:00:00.000Z"),
    startedAt: new Date("2026-09-11T10:00:01.000Z"),
    completedAt: new Date("2026-09-11T10:05:00.000Z"),
    ...over,
  };
}

export function event(
  runSeq: number,
  over: Partial<AttemptEventReadRecord> = {},
): AttemptEventReadRecord {
  return {
    eventId: `0192d4a8-7c1e-7a00-8000-0000000000e${runSeq}`,
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    attemptPublicId: "aatt_0123456789abcdefghjkmn",
    runSeq: String(runSeq),
    attemptSeq: runSeq,
    eventSchemaVersion: "1",
    eventType: "tool.call_completed",
    stage: "act",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
    payload: { capability_name: "read_file", outcome: "ok" },
    encryptedPayloadRef: null,
    observedAt: new Date(`2026-09-11T10:00:0${runSeq % 10}.000Z`),
    recordedAt: new Date(`2026-09-11T10:00:0${runSeq % 10}.500Z`),
    body: NO_BODY,
    ...over,
  };
}

/** A `tacho_events` row as the telemetry seam returns it. */
export function tachoRow(
  seq: number,
  over: Partial<TachoFrameRow> = {},
): TachoFrameRow {
  return {
    seq,
    ts: `2026-09-11 09:00:${String(seq % 60).padStart(2, "0")}.000`,
    eventId: `evt_${String(seq).padStart(26, "0")}`,
    kind: "tool_call",
    prevHash: `sha256:${String(Math.max(seq - 1, 0)).padStart(64, "0")}`,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    body: "{}",
    toolName: "Read",
    toolStatus: "ok",
    toolUseId: `tu_${seq}`,
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
    ...over,
  };
}

/**
 * An in-memory `selectTachoEvents`: strictly after the cursor, at or below
 * `throughSeq` when one is given, ascending, at most `limit`, fenced to the
 * session it was built for.
 */
export function memoryTachoFrames(sessionUuid: string, rows: TachoFrameRow[]) {
  return (args: {
    sessionUuid: string;
    afterSeq: number;
    throughSeq?: number;
    limit: number;
  }) =>
    Promise.resolve(
      args.sessionUuid === sessionUuid
        ? rows
            .filter(
              (r) =>
                r.seq > args.afterSeq &&
                (args.throughSeq === undefined || r.seq <= args.throughSeq),
            )
            .sort((a, b) => a.seq - b.seq)
            .slice(0, args.limit)
        : [],
    );
}

/**
 * An in-memory `selectTachoSubagentEvents` over `rows`, which may hold the
 * chains of several runs. Like the query, it reads the chains under the root
 * alone (`root_session_uuid`, never the root's own), only the listed ones
 * when `sessionUuids` is given, in (session, seq) order, strictly after the
 * position, at or below `throughSeq` when one is given, at most `limit`.
 */
export function memorySubagentFrames(rows: TachoFrameRow[]) {
  const ordered = [...rows].sort((a, b) =>
    a.sessionUuid === b.sessionUuid
      ? a.seq - b.seq
      : (a.sessionUuid ?? "") < (b.sessionUuid ?? "")
        ? -1
        : 1,
  );
  return (args: {
    rootSessionUuid: string;
    sessionUuids?: readonly string[];
    after: { sessionUuid: string; seq: number } | null;
    throughSeq?: number;
    limit: number;
  }) =>
    Promise.resolve(
      ordered
        .filter((r) => {
          const session = r.sessionUuid ?? "";
          if (r.rootSessionUuid !== args.rootSessionUuid) return false;
          if (session === args.rootSessionUuid) return false;
          if (
            args.sessionUuids !== undefined &&
            !args.sessionUuids.includes(session)
          )
            return false;
          if (args.throughSeq !== undefined && r.seq > args.throughSeq)
            return false;
          const after = args.after;
          if (after === null) return true;
          return (
            session > after.sessionUuid ||
            (session === after.sessionUuid && r.seq > after.seq)
          );
        })
        .slice(0, args.limit),
    );
}

/**
 * An in-memory `readAttemptEventsSince`: strictly after the cursor, ascending,
 * at most `limit`. `log` may grow between reads, which is how a long-poll test
 * lands an event mid-wait.
 */
export function memoryEvents(log: AttemptEventReadRecord[]) {
  return (_runId: string, afterRunSeq: string, limit = 200) =>
    Promise.resolve(
      log
        .filter((e) => BigInt(e.runSeq) > BigInt(afterRunSeq))
        .sort((a, b) => Number(BigInt(a.runSeq) - BigInt(b.runSeq)))
        .slice(0, limit),
    );
}

/** A subagent chain's `tacho.sessions` row, and the root it records under. */
export type SubagentChainFixture = SubagentChainRow & {
  rootSessionUuid: string;
};

/** One subagent chain under `rootSessionUuid`, as `listSubagentChains` answers it. */
export function subagentChain(
  over: Partial<SubagentChainFixture> & {
    sessionUuid: string;
    rootSessionUuid: string;
  },
): SubagentChainFixture {
  return {
    // The row id beside the session uuid, as the root fixture's pair reads.
    sessionId: `${over.sessionUuid.slice(0, 15)}000${over.sessionUuid.slice(18)}`,
    parentSessionUuid: over.rootSessionUuid,
    subagentId: "agent-1",
    subagentType: "Explore",
    spawnToolUseId: "toolu_A",
    seqCount: 0,
    startedAt: new Date("2026-09-11T09:01:00.000Z"),
    lastEventAt: new Date("2026-09-11T09:02:00.000Z"),
    createdAt: new Date("2026-09-11T09:01:00.000Z"),
    finalHash: null,
    sealedAt: null,
    enforcementTier: "observe",
    completenessGaps: [],
    replayGrade: null,
    ...over,
  };
}

/**
 * An in-memory `listSubagentChains` over `rows`, which may hold the chains
 * of several runs. Like the query, it lists the chains under the root alone
 * (never the root's own), only the named ones when `sessionUuids` is given,
 * in the order they started, at most `limit`.
 */
export function memorySubagentChains(rows: readonly SubagentChainFixture[]) {
  return (
    rootSessionUuid: string,
    options: { sessionUuids?: readonly string[]; limit?: number } = {},
  ): Promise<SubagentChainRow[]> =>
    Promise.resolve(
      rows
        .filter(
          (r) =>
            r.rootSessionUuid === rootSessionUuid &&
            r.sessionUuid !== rootSessionUuid &&
            (options.sessionUuids === undefined ||
              options.sessionUuids.includes(r.sessionUuid)),
        )
        .sort(
          (a, b) =>
            a.startedAt.getTime() - b.startedAt.getTime() ||
            (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
        )
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
        .map(({ rootSessionUuid: _root, ...row }) => row),
    );
}

/**
 * An in-memory `selectTachoChainHeads` over `rows`: the last seq each listed
 * chain holds under the root, fenced by `root_session_uuid`, with a chain
 * that holds no row left out. `rows` may grow between reads, which is how a
 * long-poll test lands a subagent's frame mid-wait.
 */
export function memoryChainHeads(rows: TachoFrameRow[]) {
  return (args: {
    rootSessionUuid: string;
    sessionUuids: readonly string[];
  }): Promise<{ sessionUuid: string; lastSeq: number }[]> => {
    const last = new Map<string, number>();
    for (const r of rows) {
      const session = r.sessionUuid ?? "";
      if (r.rootSessionUuid !== args.rootSessionUuid) continue;
      if (!args.sessionUuids.includes(session)) continue;
      last.set(session, Math.max(last.get(session) ?? -1, r.seq));
    }
    return Promise.resolve(
      [...last.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([sessionUuid, lastSeq]) => ({ sessionUuid, lastSeq })),
    );
  };
}
