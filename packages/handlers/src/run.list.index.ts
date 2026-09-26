// The run index behind `list_runs`'s filters, search, sort, offset and total
// (#3837). The keyset page in `run.list.ts` reads each store newest first and
// merges the two in memory, which is right for "the newest N runs" and wrong
// for everything else: a search, a facet or an order other than newest first
// has to see every run in the workspace, not the ones one page read.
//
// So this module runs one UNION ALL over both stores, applies the filters and
// the search inside each branch, orders the union by the requested column and
// skips `offset` rows. It returns only the public ids, in order. The caller
// then reads those rows through the same selects and mappers the keyset page
// uses, so a run reads the same whichever path listed it.
//
//   ledger  V2 `agent.agent_runs`, the in-app agent's surfaces left out, with
//           the latest attempt seal (a lateral join) for the tier and grade.
//   tacho   root `tacho.sessions`, with the host and the operator joined for
//           the search.
//
// The status, tier and grade each branch filters and sorts on are the words
// the row mappers publish (`lib/run-item.ts`), computed in SQL from the same
// closed vocabularies: a ledger run with no graded seal reads `harness`, a live
// ledger run has no grade, and a word outside a vocabulary reads as the mapper
// reads it. The status CASE is built by calling the mappers themselves, so the
// two cannot drift.
//
// The total is a bounded count. Each branch counts at most
// RUN_LIST_TOTAL_BOUND + 1 rows, so a workspace with a million runs costs the
// same as one with ten thousand, and a sum past the bound reads null.
//
// Every query names org_id and workspace_id as well as running under RLS,
// for the reason `run.list.ts` gives: a local stack runs with the RLS bypass on.
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  IN_APP_AGENT_SURFACES,
  RUN_LIST_TOTAL_BOUND,
  type RunListInput,
  type RunListOutput,
  type RunReplayFilter,
  type RunSortKey,
} from "@oxagen/oxagen/contracts/run.list";
import {
  notWitnessRun,
  operatorUserJoin,
  schema,
  type Tx,
  withTenantDb,
} from "@oxagen/database";
import { GRADE_ENFORCEMENT_TIERS, REPLAY_GRADES } from "@oxagen/tacho";
import {
  and,
  desc,
  eq,
  isNull,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import {
  type LedgerRunRow,
  ledgerRunStatus,
  type TachoSessionRow,
  tachoRunStatus,
} from "./lib/run-item";
import { logger } from "./logger";

/** The tenant a read is fenced to (`RunScope` in run.list.ts). */
export type RunScope = { orgId: string; workspaceId: string };

type RunStatus = NonNullable<RunListInput["status"]>[number];
type RunTier = NonNullable<RunListInput["tier"]>[number];

/** The order a list is read in. Absent on the input means newest first. */
export type RunOrder = { key: RunSortKey; dir: "asc" | "desc" };

export const NEWEST_FIRST: RunOrder = { key: "started", dir: "desc" };

/** Whether an order is the keyset page's own: `started`, descending. */
export function isNewestFirst(order: RunOrder | undefined): boolean {
  return (
    order === undefined || (order.key === "started" && order.dir === "desc")
  );
}

/**
 * Does this input need the index? Any filter, the search, an order other
 * than newest first, or an offset past the first row. An input with none of
 * them lists exactly as it did before the index existed.
 */
export function usesRunIndex(input: RunListInput): boolean {
  return (
    input.status !== undefined ||
    input.tier !== undefined ||
    input.replayGrade !== undefined ||
    input.query !== undefined ||
    !isNewestFirst(input.sort) ||
    (input.offset ?? 0) > 0
  );
}

/**
 * Refuse the combinations no single read can answer, as `invalid_input` with
 * a code the caller can branch on.
 *
 * - `cursor_with_offset`: a cursor already says where the page starts.
 * - `cursor_with_sort`: a cursor is a position in the newest-first order and
 *   means nothing in any other.
 * - `pull_requests_with_offset`, `pull_requests_with_sort`: the pull requests
 *   a session names are read from its frames in ClickHouse, a page at a time,
 *   so a pull-request filter pages newest first by cursor and cannot skip to
 *   row N of another order.
 */
export function refuseRunIndexInput(
  capability: string,
  input: RunListInput,
): void {
  const refuse = (code: string) =>
    new CapabilityError(capability, "invalid_input", code);
  const sorted = !isNewestFirst(input.sort);
  if (input.cursor !== undefined) {
    if (input.offset !== undefined) throw refuse("cursor_with_offset");
    if (sorted) throw refuse("cursor_with_sort");
  }
  const pullRequests = input.pullRequests ?? "any";
  if (pullRequests !== "any") {
    if ((input.offset ?? 0) > 0) throw refuse("pull_requests_with_offset");
    if (sorted) throw refuse("pull_requests_with_sort");
  }
}

/**
 * The text as a LIKE pattern that matches it literally: `%`, `_` and the
 * escape character itself are escaped with a backslash, Postgres's default
 * LIKE escape. Without it a search for `50%` would match every run whose text
 * contains `50`.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** What one index read asks for. */
export type RunIndexRequest = {
  status?: readonly RunStatus[];
  tier?: readonly RunTier[];
  replayGrade?: readonly RunReplayFilter[];
  query?: string;
  order: RunOrder;
  /** A newest-first position to read after; only with `NEWEST_FIRST`. */
  cursor: { at: string; id: string } | null;
  offset: number;
  limit: number;
  /** Leave out every run a verdict names as its witness run (an API-key caller). */
  withoutWitnessRuns: boolean;
  /**
   * List wrapped sessions only. A pull-request filter sets it: a ledger run's
   * pull requests are receipts this read cannot see.
   */
  sessionsOnly: boolean;
};

/** The index request an input makes, at a position and page size the caller chose. */
export function runIndexRequest(
  input: RunListInput,
  at: {
    cursor: { at: string; id: string } | null;
    limit: number;
    withoutWitnessRuns: boolean;
  },
): RunIndexRequest {
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
    ...(input.replayGrade === undefined
      ? {}
      : { replayGrade: input.replayGrade }),
    ...(input.query === undefined ? {} : { query: input.query }),
    order: input.sort ?? NEWEST_FIRST,
    cursor: at.cursor,
    // Only the first read of a page skips rows. A later read carries on from
    // the cursor the one before it left.
    offset: at.cursor === null ? (input.offset ?? 0) : 0,
    limit: at.limit,
    withoutWitnessRuns: at.withoutWitnessRuns,
    sessionsOnly: (input.pullRequests ?? "any") !== "any",
  };
}

// ---- SQL ------------------------------------------------------------------------------

/** What an index query needs from a transaction: the select builder. */
export type IndexDb = Pick<Tx, "select">;

const runs = schema.agentRuns;
const seals = schema.agentRunAttemptSeals;
const sessions = schema.tachoSessions;
const hosts = schema.tachoHosts;
const totals = schema.runTotals;

/** The words each store's status column can hold (its CHECK). */
const LEDGER_STATUS_WORDS = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
const TACHO_OUTCOME_WORDS = [
  "running",
  "completed",
  "aborted",
  "crashed",
  "unknown",
] as const;

/** The lifecycle words in their sort order, as the contract lists them. */
const STATUS_ORDER: readonly RunStatus[] = ["live", "sealed", "halted"];

/** A literal list of bound values, for `in (…)` and `array[…]`. */
function valueList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** `column in (…)`, or false for an empty list (Postgres refuses `in ()`). */
function inList(column: SQLWrapper, values: readonly string[]): SQL {
  return values.length === 0
    ? sql`false`
    : sql`${column} in (${valueList(values)})`;
}

/** The store words a set of lifecycle words covers, through the mapper itself. */
function storeWords(
  words: readonly string[],
  toStatus: (word: string) => RunStatus,
  wanted: readonly RunStatus[],
): string[] {
  return words.filter((word) => wanted.includes(toStatus(word)));
}

/** The lifecycle word's position in STATUS_ORDER, from a store's status column. */
function statusOrdinal(
  column: SQLWrapper,
  words: readonly string[],
  toStatus: (word: string) => RunStatus,
): SQL {
  const arms = STATUS_ORDER.map(
    (status, rank) =>
      sql`when ${inList(column, storeWords(words, toStatus, [status]))} then ${sql.raw(String(rank))}`,
  );
  return sql`(case ${sql.join(arms, sql` `)} end)`;
}

/** A word's position in a closed vocabulary, 1-based; null for a null word. */
function ordinal(word: SQL, vocabulary: readonly string[]): SQL {
  return sql`array_position(array[${valueList(vocabulary)}]::text[], ${word})`;
}

/** A column read through a closed vocabulary: the word, or `fallback` outside it. */
function vocabularyWord(
  column: SQLWrapper,
  vocabulary: readonly string[],
  fallback: SQL,
): SQL {
  return sql`(case when ${inList(column, vocabulary)} then ${column}::text else ${fallback} end)`;
}

/** Millisecond precision, the keyset page's own, so a cursor compares exactly. */
const ms = (column: SQL | typeof sessions.startedAt) =>
  sql`date_trunc('milliseconds', ${column})`;

const ledgerStartedAt = ms(sql`coalesce(${runs.startedAt}, ${runs.createdAt})`);
const tachoStartedAt = ms(sessions.startedAt);

/** Newest first after the cursor, ties broken on public id compared byte-wise. */
function afterCursor(
  startedAt: SQL,
  publicId: typeof runs.publicId | typeof sessions.publicId,
  cursor: RunIndexRequest["cursor"],
): SQL | undefined {
  if (cursor === null) return undefined;
  // An ISO string cast in SQL: a JS Date against a raw fragment reaches the
  // driver as an object and fails (see `beforeCursor` in run.list.ts).
  const instant = sql`${new Date(cursor.at).toISOString()}::timestamptz`;
  return sql`(${startedAt} < ${instant} or (${startedAt} = ${instant} and ${publicId} collate "C" < ${cursor.id}))`;
}

/** The expressions a branch filters, searches and sorts on. */
type BranchWords = {
  status: SQL;
  tier: SQL;
  replay: SQL;
  agentKey: SQL;
  operatorName: SQL;
  cost: SQL;
  /** Every text column the search reads. */
  searched: SQL[];
};

/** The replay filter over a branch's grade: the grades asked for, or none recorded. */
function replayFilter(
  grade: SQL,
  wanted: readonly RunReplayFilter[],
): SQL | undefined {
  const grades = wanted.filter((word) => word !== "not_recorded");
  const clauses = [
    ...(grades.length > 0 ? [inList(grade, grades)] : []),
    ...(wanted.includes("not_recorded") ? [sql`${grade} is null`] : []),
  ];
  return or(...clauses);
}

/** The WHERE clauses every branch shares: the filters and the search. */
function sharedFilters(words: BranchWords, req: RunIndexRequest): SQL[] {
  const out: SQL[] = [];
  if (req.tier !== undefined) out.push(inList(words.tier, req.tier));
  if (req.replayGrade !== undefined) {
    const filter = replayFilter(words.replay, req.replayGrade);
    if (filter !== undefined) out.push(filter);
  }
  if (req.query !== undefined) {
    const pattern = `%${escapeLike(req.query)}%`;
    const any = or(
      ...words.searched.map((column) => sql`${column} ilike ${pattern}`),
    );
    if (any !== undefined) out.push(any);
  }
  return out;
}

/** The value a branch projects for the requested order; null for `started`. */
function sortValue(words: BranchWords, key: RunSortKey): SQL {
  switch (key) {
    case "started":
      return sql`null::text`;
    case "agent":
      return sql`lower(${words.agentKey})`;
    case "operator":
      return sql`lower(${words.operatorName})`;
    case "status":
      return words.status;
    case "tier":
      return ordinal(words.tier, GRADE_ENFORCEMENT_TIERS);
    case "replay":
      return ordinal(words.replay, REPLAY_GRADES);
    case "cost":
      return sql`${words.cost}::bigint`;
  }
}

/** The run's priced cost, as `postgresReadRunRollups` reads it: none without a basis. */
const rollupCost = sql`(case when ${totals.costBasis} is not null then ${totals.costMicros} end)`;

/** `schema.users.display_name`, blank read as unrecorded, as the mappers read it. */
const operatorName = sql`nullif(btrim(${schema.users.displayName}), '')`;

function ledgerBranch(db: IndexDb, scope: RunScope, req: RunIndexRequest) {
  const latestSeal = db
    .select({ tier: seals.enforcementTier, grade: seals.replayGrade })
    .from(seals)
    .where(
      and(
        eq(seals.runId, runs.id),
        eq(seals.orgId, runs.orgId),
        eq(seals.workspaceId, runs.workspaceId),
      ),
    )
    .orderBy(desc(seals.sealedAt))
    .limit(1)
    .as("latest_seal");
  const liveWords = storeWords(LEDGER_STATUS_WORDS, ledgerRunStatus, ["live"]);
  const agentKey = sql`(nullif(${schema.organizations.namespace}, '') || '.' || nullif(${schema.workspaces.namespace}, '') || '.' || nullif(${schema.agents.slug}, ''))`;
  const words: BranchWords = {
    status: statusOrdinal(runs.status, LEDGER_STATUS_WORDS, ledgerRunStatus),
    // A seal written before the column, and a run with no seal, read `harness`.
    tier: vocabularyWord(
      sql`${latestSeal.tier}`,
      GRADE_ENFORCEMENT_TIERS,
      sql`'harness'`,
    ),
    // A live run has sealed nothing, so it has no grade whatever an earlier
    // attempt's seal recorded.
    replay: sql`(case when ${inList(runs.status, liveWords)} then null else ${vocabularyWord(sql`${latestSeal.grade}`, REPLAY_GRADES, sql`null`)} end)`,
    agentKey,
    operatorName,
    cost: rollupCost,
    searched: [
      sql`${runs.publicId}`,
      sql`${runs.name}`,
      sql`${runs.spec}->>'goal'`,
      agentKey,
      operatorName,
    ],
  };
  const where = and(
    eq(runs.orgId, scope.orgId),
    eq(runs.workspaceId, scope.workspaceId),
    eq(runs.specVersion, 2),
    notInArray(runs.surface, [...IN_APP_AGENT_SURFACES]),
    req.status === undefined
      ? undefined
      : inList(
          runs.status,
          storeWords(LEDGER_STATUS_WORDS, ledgerRunStatus, req.status),
        ),
    ...sharedFilters(words, req),
    afterCursor(ledgerStartedAt, runs.publicId, req.cursor),
    req.withoutWitnessRuns ? notWitnessRun(runs) : undefined,
  );
  return db
    .select({
      source: sql<"ledger" | "tacho">`'ledger'`.as("source"),
      publicId: sql<string>`${runs.publicId} collate "C"`.as("public_id"),
      startedAt: sql<unknown>`${ledgerStartedAt}`.as("started_at"),
      sortValue: sql<unknown>`${sortValue(words, req.order.key)}`.as(
        "sort_value",
      ),
    })
    .from(runs)
    .innerJoin(
      schema.workspaces,
      and(
        eq(schema.workspaces.id, runs.workspaceId),
        eq(schema.workspaces.orgId, runs.orgId),
      ),
    )
    .innerJoin(schema.organizations, eq(schema.organizations.id, runs.orgId))
    .leftJoin(
      schema.agents,
      and(
        eq(schema.agents.id, runs.agentId),
        eq(schema.agents.workspaceId, runs.workspaceId),
      ),
    )
    .leftJoin(
      schema.principals,
      and(
        eq(schema.principals.id, runs.initiatingPrincipalId),
        eq(schema.principals.orgId, runs.orgId),
      ),
    )
    .leftJoin(schema.users, operatorUserJoin)
    .leftJoinLateral(latestSeal, sql`true`)
    .leftJoin(
      totals,
      and(
        eq(totals.runId, runs.publicId),
        eq(totals.orgId, runs.orgId),
        eq(totals.workspaceId, runs.workspaceId),
      ),
    )
    .where(where);
}

function tachoBranch(db: IndexDb, scope: RunScope, req: RunIndexRequest) {
  const words: BranchWords = {
    status: statusOrdinal(
      sessions.outcome,
      TACHO_OUTCOME_WORDS,
      tachoRunStatus,
    ),
    tier: vocabularyWord(
      sessions.enforcementTier,
      GRADE_ENFORCEMENT_TIERS,
      sql`'harness'`,
    ),
    replay: vocabularyWord(
      sql`${sessions.replayGrade}`,
      REPLAY_GRADES,
      sql`null`,
    ),
    agentKey: sql`nullif(${sessions.agentKey}, '')`,
    operatorName,
    // The rollup's figure, else what the agent reported, the fallback the
    // Fleet row shows (`shownCost`).
    cost: sql`coalesce(${rollupCost}, case when ${sessions.totalCostMicros} > 0 or ${sessions.costBasis} is not null then ${sessions.totalCostMicros} end)`,
    searched: [
      sql`${sessions.publicId}`,
      sql`${sessions.harnessTitle}`,
      sql`${sessions.name}`,
      sql`${sessions.title}`,
      sql`${sessions.agentKey}`,
      operatorName,
      sql`${sessions.modelInitial}`,
      sql`${sessions.modelFinal}`,
      sql`${hosts.hostname}`,
    ],
  };
  const where = and(
    eq(sessions.orgId, scope.orgId),
    eq(sessions.workspaceId, scope.workspaceId),
    isNull(sessions.parentSessionUuid),
    req.status === undefined
      ? undefined
      : inList(
          sessions.outcome,
          storeWords(TACHO_OUTCOME_WORDS, tachoRunStatus, req.status),
        ),
    ...sharedFilters(words, req),
    afterCursor(tachoStartedAt, sessions.publicId, req.cursor),
    req.withoutWitnessRuns ? notWitnessRun(sessions) : undefined,
  );
  return db
    .select({
      source: sql<"ledger" | "tacho">`'tacho'`.as("source"),
      publicId: sql<string>`${sessions.publicId} collate "C"`.as("public_id"),
      startedAt: sql<unknown>`${tachoStartedAt}`.as("started_at"),
      sortValue: sql<unknown>`${sortValue(words, req.order.key)}`.as(
        "sort_value",
      ),
    })
    .from(sessions)
    .leftJoin(
      schema.principals,
      and(
        eq(schema.principals.id, sessions.initiatingPrincipalId),
        eq(schema.principals.orgId, sessions.orgId),
      ),
    )
    .leftJoin(schema.users, operatorUserJoin)
    .leftJoin(
      hosts,
      and(eq(hosts.id, sessions.hostId), eq(hosts.orgId, sessions.orgId)),
    )
    .leftJoin(
      totals,
      and(
        eq(totals.runId, sessions.publicId),
        eq(totals.orgId, sessions.orgId),
        eq(totals.workspaceId, sessions.workspaceId),
      ),
    )
    .where(where);
}

/**
 * The ORDER BY of the index. Output column names only, which is all Postgres
 * accepts on a UNION: the requested column with nulls last in both
 * directions, then newest first, then public id (projected `collate "C"`, so
 * the tie-break is byte-wise, as the keyset page's is).
 */
export function runIndexOrder(order: RunOrder): SQL[] {
  const dir = order.dir === "asc" ? sql`asc` : sql`desc`;
  const startedAt = sql.identifier("started_at");
  const publicId = sql.identifier("public_id");
  if (order.key === "started")
    return [sql`${startedAt} ${dir}`, sql`${publicId} ${dir}`];
  return [
    sql`${sql.identifier("sort_value")} ${dir} nulls last`,
    sql`${startedAt} desc`,
    sql`${publicId} desc`,
  ];
}

/**
 * One page of the index: `limit + 1` public ids in order from `offset`, so
 * the caller can tell whether more follow.
 */
export function runIndexPageQuery(
  db: IndexDb,
  scope: RunScope,
  req: RunIndexRequest,
) {
  const order = runIndexOrder(req.order);
  const tacho = tachoBranch(db, scope, req);
  if (req.sessionsOnly)
    return tacho
      .orderBy(...order)
      .limit(req.limit + 1)
      .offset(req.offset);
  return ledgerBranch(db, scope, req)
    .unionAll(tacho)
    .orderBy(...order)
    .limit(req.limit + 1)
    .offset(req.offset);
}

/**
 * The bounded count per branch: each reads at most RUN_LIST_TOTAL_BOUND + 1
 * matching rows. The ledger branch is absent when the request lists sessions
 * only. Order, cursor and offset do not change a count, so none is applied.
 */
export function runIndexCountQueries(
  db: IndexDb,
  scope: RunScope,
  req: RunIndexRequest,
) {
  const unpaged: RunIndexRequest = {
    ...req,
    order: NEWEST_FIRST,
    cursor: null,
    offset: 0,
  };
  const bound = RUN_LIST_TOTAL_BOUND + 1;
  const n = sql<number>`count(*)::int`.mapWith(Number);
  return {
    ledger: req.sessionsOnly
      ? null
      : db
          .select({ n })
          .from(ledgerBranch(db, scope, unpaged).limit(bound).as("matched")),
    tacho: db
      .select({ n })
      .from(tachoBranch(db, scope, unpaged).limit(bound).as("matched")),
  };
}

// ---- The store ------------------------------------------------------------------------

/** A run the index listed: which store holds it, and its public id. */
export type RunIndexEntry = { source: "ledger" | "tacho"; publicId: string };

/** The index reads. Each runs inside the kernel's tenant scope. */
export type RunIndexStore = {
  /** Up to `limit + 1` entries, in the requested order from `offset`. */
  page: (scope: RunScope, req: RunIndexRequest) => Promise<RunIndexEntry[]>;
  /** The matching runs, counted to at most RUN_LIST_TOTAL_BOUND + 1 per store. */
  count: (scope: RunScope, req: RunIndexRequest) => Promise<number>;
};

export const postgresRunIndex: RunIndexStore = {
  page: async (scope, req) => {
    const rows = await withTenantDb((tx) => runIndexPageQuery(tx, scope, req));
    return rows.map((row) => ({ source: row.source, publicId: row.publicId }));
  },
  count: (scope, req) =>
    withTenantDb(async (tx) => {
      const queries = runIndexCountQueries(tx, scope, req);
      const [ledger, tacho] = await Promise.all([
        queries.ledger ?? Promise.resolve([{ n: 0 }]),
        queries.tacho,
      ]);
      return (ledger[0]?.n ?? 0) + (tacho[0]?.n ?? 0);
    }),
};

/**
 * The rows a page of public ids names, read through the keyset page's own
 * selects (`run.list.ts` wires them), fenced to the scope. A run missing from
 * the answer was removed between the two reads and is left out of the page.
 */
export type RunRowsByPublicId = {
  ledger: (
    scope: RunScope,
    publicIds: readonly string[],
  ) => Promise<LedgerRunRow[]>;
  tacho: (
    scope: RunScope,
    publicIds: readonly string[],
  ) => Promise<TachoSessionRow[]>;
};

export type RunIndexDeps = { index: RunIndexStore; rows: RunRowsByPublicId };

/** A listed run before it is mapped, in the shape `run.list.ts` pages. */
export type RunIndexItem =
  | { kind: "ledger"; id: string; startedAt: string; row: LedgerRunRow }
  | { kind: "tacho"; id: string; startedAt: string; row: TachoSessionRow };

/**
 * One page from the index: the rows in the index's order, and whether more
 * match after them. The caller turns `more` into a cursor when the order is
 * newest first; in any other order a caller pages by `offset`.
 */
export async function readRunIndexPage(
  deps: RunIndexDeps,
  scope: RunScope,
  req: RunIndexRequest,
): Promise<{ items: RunIndexItem[]; more: boolean }> {
  const entries = await deps.index.page(scope, req);
  const more = entries.length > req.limit;
  const page = entries.slice(0, req.limit);
  const ids = (source: RunIndexEntry["source"]) =>
    page.flatMap((entry) => (entry.source === source ? [entry.publicId] : []));
  const ledgerIds = ids("ledger");
  const tachoIds = ids("tacho");
  const [ledger, tacho] = await Promise.all([
    ledgerIds.length === 0
      ? Promise.resolve([])
      : deps.rows.ledger(scope, ledgerIds),
    tachoIds.length === 0
      ? Promise.resolve([])
      : deps.rows.tacho(scope, tachoIds),
  ]);
  const ledgerById = new Map(ledger.map((row) => [row.run.publicId, row]));
  const tachoById = new Map(tacho.map((row) => [row.session.publicId, row]));
  const items = page.flatMap((entry): RunIndexItem[] => {
    if (entry.source === "ledger") {
      const row = ledgerById.get(entry.publicId);
      return row === undefined
        ? []
        : [
            {
              kind: "ledger",
              id: row.run.publicId,
              startedAt: (row.run.startedAt ?? row.run.createdAt).toISOString(),
              row,
            },
          ];
    }
    const row = tachoById.get(entry.publicId);
    return row === undefined
      ? []
      : [
          {
            kind: "tacho",
            id: row.session.publicId,
            startedAt: row.session.startedAt.toISOString(),
            row,
          },
        ];
  });
  return { items, more };
}

/** `total` and `totalBound` for a count: null past the bound. */
export function totalOf(
  count: number,
): Required<Pick<RunListOutput, "total" | "totalBound">> {
  return {
    total: count > RUN_LIST_TOTAL_BOUND ? null : count,
    totalBound: RUN_LIST_TOTAL_BOUND,
  };
}

/**
 * The page's total, or nothing. A pull-request filter is not counted: only
 * the frames in ClickHouse answer it, a page at a time. A count that fails
 * leaves the rows up without a total, and says so in the log.
 */
export async function countRuns(
  index: RunIndexStore,
  scope: RunScope,
  req: RunIndexRequest,
): Promise<Pick<RunListOutput, "total" | "totalBound">> {
  if (req.sessionsOnly) return {};
  try {
    return totalOf(await index.count(scope, req));
  } catch (err) {
    logger.warn(
      { err },
      "list_runs: the run count failed; the page has no total",
    );
    return {};
  }
}
