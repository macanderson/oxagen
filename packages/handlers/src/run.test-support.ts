// In-memory stores for the run handler tests. Each fake applies the same
// tenant fence, ordering, cursor and page semantics as the Postgres query it
// stands in for, so a test proves paging and scoping behaviour rather than the
// shape of a canned reply.
import type { CapabilityContext } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import type { AttemptEventReadRecord, RunSummary } from "@oxagen/run-ledger";
import type { TachoFrameRow, TokenUsageByStepRow } from "@oxagen/telemetry";
import { NO_BODY } from "@oxagen/run-ledger";
import {
  type LedgerEventRollup,
  type LedgerRunRow,
  type LedgerSeal,
  type PageQuery,
  type RunQueries,
  type RunScope,
  type SumTokenUsage,
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

/**
 * A `withTenantDb` transaction double that answers the role gate's two
 * queries (`assertOrgRole` in @oxagen/iam): the acting user's principal and
 * one org-role assignment. `null` is a user with no org role. Every other
 * read the run handlers make goes through injected deps, so a test file
 * mocks `@oxagen/database` with this and nothing else.
 */
export function roleTx(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
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
  rollup?: LedgerEventRollup;
  seal?: LedgerSeal | null;
  usage?: TokenUsageByStepRow | null;
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
    ...over,
  };
}

export type TachoFixture = TachoSessionRow & {
  scope: RunScope;
  /** A subagent chain: never a root session. */
  child?: boolean;
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
      publicId,
      sessionUuid: "0192d4a8-7c1e-7a00-8000-00000000c0de",
      agentKey: "acme.core.cc-laptop",
      outcome: "completed",
      numTurns: 2,
      numModelCalls: 3,
      numToolCalls: 4,
      seqCount: 207,
      totalCostMicros: 0,
      costBasis: null,
      hasUnknownModelCost: null,
      startedAt: new Date("2026-09-11T09:00:00.000Z"),
      sealedAt: new Date("2026-09-11T09:05:00.000Z"),
      replayGrade: null,
      completenessGaps: [],
      enforcementTier: "observe",
      name: null,
      summary: null,
      summaryGeneratedAt: null,
      summaryModel: null,
      ...session,
    },
    operatorPublicId: "prn_0123456789abcdefghjkmn",
    ...rest,
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
  sumTokenUsage: SumTokenUsage;
  /** Every `sumTokenUsage` call, so a test can assert ClickHouse was not read. */
  usageCalls: (readonly string[])[];
};

export function memoryStores(
  ledger: readonly LedgerFixture[],
  tacho: readonly TachoFixture[],
): MemoryStores {
  const usageCalls: (readonly string[])[] = [];
  const inScope = (scope: RunScope) => ({
    ledger: ledger.filter((r) => sameScope(r.scope, scope)),
    tacho: tacho.filter((r) => sameScope(r.scope, scope)),
  });
  return {
    usageCalls,
    queries: {
      ledgerPage: (scope, q) =>
        Promise.resolve(
          pageOf(
            inScope(scope)
              .ledger.filter((r) => r.specVersion === 2)
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
              .map((r) => ({
                at: r.session.startedAt.getTime(),
                id: r.session.publicId,
                row: r,
              })),
            q,
          ).map(({ row }) => ({
            session: row.session,
            operatorPublicId: row.operatorPublicId,
          })),
        ),
      tachoSession: (scope, publicId) => {
        const row = inScope(scope).tacho.find(
          (r) => r.session.publicId === publicId && !r.child,
        );
        return Promise.resolve(
          row
            ? { session: row.session, operatorPublicId: row.operatorPublicId }
            : null,
        );
      },
    },
    sumTokenUsage: ({ executionStepIds }) => {
      usageCalls.push(executionStepIds);
      return Promise.resolve(
        new Map(
          ledger
            .filter((r) => executionStepIds.includes(r.run.runId) && r.usage)
            .map((r) => [r.run.runId, r.usage as TokenUsageByStepRow]),
        ),
      );
    },
  };
}

export function usage(
  over: Partial<TokenUsageByStepRow> = {},
): TokenUsageByStepRow {
  return {
    executionStepId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
    costMicros: 12_500,
    inputTokens: 1_000,
    outputTokens: 200,
    llmCalls: 3,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    principalId: "0192d4a8-7c1e-7a00-8000-0000000000p1",
    principalKind: "human",
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
 * An in-memory `selectTachoEvents`: strictly after the cursor, ascending, at
 * most `limit`, fenced to the session it was built for.
 */
export function memoryTachoFrames(sessionUuid: string, rows: TachoFrameRow[]) {
  return (args: { sessionUuid: string; afterSeq: number; limit: number }) =>
    Promise.resolve(
      args.sessionUuid === sessionUuid
        ? rows
            .filter((r) => r.seq > args.afterSeq)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, args.limit)
        : [],
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
