// The hourly refresh of `cost.run_pr_outcomes` for one workspace (#4491).
//
// For each sealed run in the trailing 30 days, the pass:
//
//   1. names the pull requests the run opened: the links a wrapped run's
//      record holds (`tacho.run_pull_requests`), and the
//      `provider_publish.pull_request_opened` receipts a ledger run recorded.
//      A pass walks the receipts of at most 100 ledger runs, each from where
//      its last pass stopped (`cost.run_pr_receipt_walks`). A run it cannot
//      resolve waits six hours before the next try, so it holds no slot,
//   2. reads from GitHub the state, head commit CI, and head branch of each
//      pull request whose row is not settled (`needsForgeRead`), at most 60
//      per pass, least recently asked first,
//   3. keeps the reverts a merged pull request's body names
//      (`Reverts owner/repo#N`) in `cost.run_pr_reverts`,
//   4. marks each row with the kept reverts that name it: the ones found in
//      step 3, and the ones the GitHub deliveries and earlier passes kept,
//   5. writes the rows that changed, with the run's terminal reason on each,
//      and
//   6. gives a run that opened no pull request one `none` row that carries
//      its terminal reason.
//
// A revert is kept before any row is written, so a pass that fails after it
// loses nothing: the reverting pull request's row can settle, and the next
// pass still reads the revert back. A human revert of a run's pull request
// reaches the table through the GitHub deliveries
// (functions/cost.run-pr-outcomes.ts), which keep it the same way. A GitLab
// merge request keeps the state its link holds, since the pass reads only
// GitHub.
import {
  blankOutcome,
  ciStateOfRead,
  type CiRead,
  listOutcomeRuns,
  needsForgeRead,
  OUTCOME_FORGE_READS_PER_PASS,
  OUTCOME_WINDOW_DAYS,
  type OutcomeRow,
  type OutcomeRun,
  type OutcomeScope,
  type PrStateRead,
  prKeyOf,
  readOutcomeRows,
  readRevertEvidence,
  readRunTerminalReasons,
  readTachoRunPrLinks,
  type RevertEvidence,
  revertEvidenceOf,
  revertTargetsOf,
  type RunPr,
  type RunPrState,
  saveOutcomeRows,
  saveRevertEvidence,
  type TachoPrLink,
  withCiRead,
  withHeadBranchRead,
  withStateRead,
  withStoredReverts,
  withTerminalReason,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import {
  createGitHubClient,
  GitHubApiError,
  type GitHubClient,
} from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import type { RunPrOutcomesResult } from "@oxagen/inngest-functions/run-pr-outcomes-runner";
import type { AttemptEventReadRecord, RunStore } from "@oxagen/run-ledger";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "../logger";
import { buildCiSummary } from "./ci-status";
import { githubConnectionOf } from "./run-pull-request-backfill";
import { ledgerStore } from "./run-read";
import {
  type LedgerReceipt,
  type ReceiptWalk,
  readReceiptWalks,
  saveReceiptWalks,
  type UnresolvedReason,
} from "./run-pr-receipt-walks";
import {
  type ConnectedRunRepository,
  connectedRunRepositories,
} from "./run-work";

/** Ledger runs whose receipts one pass walks or names. */
export const OUTCOME_LEDGER_READS_PER_PASS = 100;

/** How long a ledger run the refresh could not resolve waits before the next try. */
export const OUTCOME_UNRESOLVED_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Events one page of a receipt walk reads, and pages one pass reads per run:
 * at most 10,000 events a run a pass, as `readLedgerPrReceipts` reads them.
 */
export const RECEIPT_WALK_PAGE = 500;
export const RECEIPT_WALK_PAGES = 20;

/**
 * Run ids one read binds. A workspace can have tens of thousands of sealed
 * runs in the window, and PostgreSQL takes at most 65,535 bind parameters in
 * one statement.
 */
export const OUTCOME_RUN_ID_BATCH = 1_000;

/** GitHub reads one pass runs at a time. */
const FORGE_READ_CONCURRENCY = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A pull request a ledger run's receipt names, with the head commit it recorded. */
export interface LedgerRunPr extends RunPr {
  headSha: string | null;
}

/** A ledger run the pass reads, with its stored walk, or null when it has none yet. */
export interface LedgerWalkRequest {
  runId: string;
  walk: ReceiptWalk | null;
}

/** What one pass learned about a ledger run's receipts. */
export interface LedgerRunRead {
  /** The walk as the pass leaves it, to be stored. */
  walk: ReceiptWalk;
  /**
   * The run's pull requests, once its walk is complete and every receipt
   * names a connected repository. Null until then: rows for part of a run
   * would read as the whole of it.
   */
  prs: LedgerRunPr[] | null;
}

/** What one GitHub read found about a pull request. */
export interface ForgeOutcomeRead {
  state: PrStateRead;
  body: string | null;
  /** Null when the head commit's checks could not be read. */
  ci: CiRead | null;
  /** Null when the branch could not be read. */
  headBranch: { exists: boolean; readAt: Date } | null;
}

export type ForgeOutcome = ForgeOutcomeRead | "no_connection" | "unreadable";

export interface OutcomeRefreshDeps {
  now(): Date;
  listRuns(scope: OutcomeScope, now: Date): Promise<OutcomeRun[]>;
  terminalReasons(
    scope: OutcomeScope,
    runs: readonly OutcomeRun[],
  ): Promise<Map<string, string | null>>;
  readRows(scope: OutcomeScope, runIds: readonly string[]): Promise<OutcomeRow[]>;
  tachoLinks(
    scope: OutcomeScope,
    runIds: readonly string[],
  ): Promise<TachoPrLink[]>;
  /** The stored receipt walks of the given ledger runs. */
  receiptWalks(
    scope: OutcomeScope,
    runIds: readonly string[],
  ): Promise<ReceiptWalk[]>;
  /**
   * Each ledger run's walk taken one pass further, from where its stored walk
   * stopped, and the pull requests of each walk that is complete. A run the
   * pass cannot resolve comes back with `unresolved` and a retry time.
   */
  ledgerPrs(
    scope: OutcomeScope,
    runs: readonly LedgerWalkRequest[],
    now: Date,
  ): Promise<LedgerRunRead[]>;
  /** Store the walks the pass moved. */
  saveReceiptWalks(
    scope: OutcomeScope,
    walks: readonly ReceiptWalk[],
  ): Promise<void>;
  readForge(scope: OutcomeScope, pr: RunPr): Promise<ForgeOutcome>;
  /** The reverts kept for the workspace that Oxagen saw since the given time. */
  readReverts(scope: OutcomeScope, since: Date): Promise<RevertEvidence[]>;
  /** Keep reverts until their rows exist. A revert already kept is not written again. */
  saveReverts(
    scope: OutcomeScope,
    evidence: readonly RevertEvidence[],
  ): Promise<number>;
  saveRows(scope: OutcomeScope, rows: readonly OutcomeRow[]): Promise<number>;
}

interface Candidate {
  run: OutcomeRun;
  pr: RunPr;
  row: OutcomeRow;
}

const keyOf = (runId: string, prKey: string) => `${runId} ${prKey}`;

/**
 * The state a run link holds, as a read. The link knows no refs, commits, or
 * close time. A link with no time for its state gives no read, since a read
 * timed now would rewrite the row on every pass.
 */
function linkRead(link: TachoPrLink): PrStateRead | null {
  const readAt = link.stateSeenAt ?? link.sourceUpdatedAt;
  if (link.state === null || readAt === null) return null;
  return {
    state: link.state,
    readAt,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    baseRef: null,
    headRef: null,
    headSha: null,
    sourceUpdatedAt: link.sourceUpdatedAt,
  };
}

/** The row with one GitHub read folded in. */
export function foldForgeRead(row: OutcomeRow, read: ForgeOutcomeRead): OutcomeRow {
  let next = withStateRead(row, read.state);
  if (read.ci) next = withCiRead(next, read.ci);
  if (read.headBranch) next = withHeadBranchRead(next, read.headBranch);
  return next;
}

/** The pull requests one GitHub read serves: every run's row that names it. */
interface DueRead {
  prKey: string;
  pr: RunPr;
  /** The oldest `lastAskedAt` among the rows. */
  readAt: number;
  group: Candidate[];
}

/**
 * When the refresh last asked GitHub about the row's pull request, or last
 * learned its state: the later of the two, or 0 for neither. A pull request
 * GitHub refuses, or a read that fails, still counts as asked, so it moves to
 * the back of the queue.
 */
function lastAskedAt(row: OutcomeRow): number {
  return Math.max(
    row.prStateReadAt?.getTime() ?? 0,
    row.forgeReadAttemptedAt?.getTime() ?? 0,
  );
}

/** One read per batch of `OUTCOME_RUN_ID_BATCH` items, one batch at a time. */
async function inBatches<T, R>(
  items: readonly T[],
  read: (batch: readonly T[]) => Promise<readonly R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += OUTCOME_RUN_ID_BATCH)
    out.push(...(await read(items.slice(at, at + OUTCOME_RUN_ID_BATCH))));
  return out;
}

/** A ledger run due a read this pass, with its stored walk. */
interface DueLedgerRun {
  run: OutcomeRun;
  walk: ReceiptWalk | null;
}

/**
 * Whether a stored walk is due a read: one stopped at the page bound, or one
 * the refresh could not resolve whose retry time has come. A complete,
 * resolved walk is never read again, since a sealed run gains no events.
 */
function walkDue(walk: ReceiptWalk, now: Date): boolean {
  if (walk.unresolved !== null)
    return walk.retryAfter === null || walk.retryAfter.getTime() <= now.getTime();
  return !walk.complete;
}

/** A walk under way: it stopped at the page bound on its last pass and nothing stands in its way. */
function walkUnderWay(walk: ReceiptWalk | null): boolean {
  return walk !== null && walk.unresolved === null && !walk.complete;
}

/**
 * The ledger runs due a read, in the order the pass reads them. A run with no
 * stored walk is due, rows or not: a run the refresh named before walks were
 * kept may have stopped at the old bound. Walks under way go first, so a run
 * of E events has every row within ceil(E / 10,000) passes while fewer than
 * 100 walks are under way. Then the runs least recently tried, never-tried
 * first, newest first among equals. A run waiting on its retry time is not
 * due and takes no slot.
 */
function dueLedgerRuns(
  runs: readonly OutcomeRun[],
  walks: ReadonlyMap<string, ReceiptWalk>,
  now: Date,
): DueLedgerRun[] {
  const due: DueLedgerRun[] = [];
  for (const run of runs) {
    if (run.runSource !== "ledger") continue;
    const walk = walks.get(run.runId) ?? null;
    if (walk === null || walkDue(walk, now)) due.push({ run, walk });
  }
  return due.sort((a, b) => {
    const underWay =
      Number(walkUnderWay(b.walk)) - Number(walkUnderWay(a.walk));
    if (underWay !== 0) return underWay;
    const tried =
      (a.walk?.attemptedAt.getTime() ?? 0) - (b.walk?.attemptedAt.getTime() ?? 0);
    if (tried !== 0) return tried;
    return b.run.startedAt.getTime() - a.run.startedAt.getTime();
  });
}

/** One refresh pass over a workspace. */
export async function refreshRunPrOutcomes(
  deps: OutcomeRefreshDeps,
  scope: OutcomeScope,
): Promise<RunPrOutcomesResult> {
  const now = deps.now();
  const runs = await deps.listRuns(scope, now);
  if (runs.length === 0)
    return { runs: 0, forgeReads: 0, deferred: 0, rows: 0, reverted: 0 };
  const runIds = runs.map((r) => r.runId);
  const runById = new Map(runs.map((r) => [r.runId, r]));
  const idsOf = (source: OutcomeRun["runSource"]) =>
    runs.filter((r) => r.runSource === source).map((r) => r.runId);
  // Every read that names runs binds at most OUTCOME_RUN_ID_BATCH of them. A
  // revert of a run's pull request lands after the run started, so the
  // reverts Oxagen saw inside the window cover every run in it.
  const [reasonEntries, stored, links, keptReverts, walks] = await Promise.all([
    inBatches(runs, async (batch) => [
      ...(await deps.terminalReasons(scope, batch)),
    ]),
    inBatches(runIds, (batch) => deps.readRows(scope, batch)),
    inBatches(idsOf("tacho"), (batch) => deps.tachoLinks(scope, batch)),
    deps.readReverts(
      scope,
      new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS),
    ),
    inBatches(idsOf("ledger"), (batch) => deps.receiptWalks(scope, batch)),
  ]);
  const reasons = new Map(reasonEntries);
  const storedByKey = new Map(stored.map((r) => [keyOf(r.runId, r.prKey), r]));

  // A run the pass cannot resolve gets a retry time and leaves the queue
  // until then, so it cannot hold a slot pass after pass.
  const dueLedger = dueLedgerRuns(
    runs,
    new Map(walks.map((w) => [w.runId, w])),
    now,
  );
  const ledgerAsked = dueLedger.slice(0, OUTCOME_LEDGER_READS_PER_PASS);
  const ledgerReads =
    ledgerAsked.length === 0
      ? []
      : await deps.ledgerPrs(
          scope,
          ledgerAsked.map(({ run, walk }) => ({ runId: run.runId, walk })),
          now,
        );
  const ledger = new Map<string, LedgerRunPr[]>();
  for (const read of ledgerReads)
    if (read.prs !== null) ledger.set(read.walk.runId, read.prs);

  const candidates = new Map<string, Candidate>();
  const add = (run: OutcomeRun, pr: RunPr): Candidate => {
    const key = keyOf(run.runId, prKeyOf(pr.provider, pr.repository, pr.number));
    let found = candidates.get(key);
    if (!found) {
      found = {
        run,
        pr,
        row: storedByKey.get(key) ?? blankOutcome(run.runId, run.runSource, pr),
      };
      candidates.set(key, found);
    }
    return found;
  };
  for (const row of stored) {
    const run = runById.get(row.runId);
    if (!run || row.provider === null || row.repository === null || row.number === null)
      continue;
    add(run, {
      provider: row.provider,
      repository: row.repository,
      number: row.number,
      url: row.url,
    });
  }
  for (const link of links) {
    const run = runById.get(link.runId);
    if (!run) continue;
    const c = add(run, link);
    const read = linkRead(link);
    if (read) c.row = withStateRead(c.row, read);
    if (c.row.url === null) c.row = { ...c.row, url: link.url };
  }
  for (const [runId, prs] of ledger) {
    const run = runById.get(runId);
    if (!run) continue;
    for (const pr of prs) {
      const c = add(run, pr);
      if (c.row.headSha === null && pr.headSha !== null)
        c.row = { ...c.row, headSha: pr.headSha };
    }
  }

  // One GitHub read per pull request, however many runs name it, least
  // recently asked first so a backlog past the cap rotates. A pull request in
  // a repository no GitHub source reads costs no API call, so it does not
  // count against the cap.
  const due = new Map<string, DueRead>();
  for (const c of candidates.values()) {
    if (c.pr.provider !== "github" || !needsForgeRead(c.row, now)) continue;
    const readAt = lastAskedAt(c.row);
    const found = due.get(c.row.prKey);
    if (found) {
      found.group.push(c);
      found.readAt = Math.min(found.readAt, readAt);
    } else due.set(c.row.prKey, { prKey: c.row.prKey, pr: c.pr, readAt, group: [c] });
  }
  const order = [...due.values()].sort((a, b) => a.readAt - b.readAt);
  const foundReverts: RevertEvidence[] = [];
  let forgeReads = 0;
  let spent = 0;
  let next = 0;
  const asked = (item: DueRead): void => {
    for (const c of item.group) c.row = { ...c.row, forgeReadAttemptedAt: now };
  };
  const readOne = async (item: DueRead): Promise<void> => {
    let read: ForgeOutcome;
    try {
      read = await deps.readForge(scope, item.pr);
    } catch (err) {
      logger.warn(
        { workspaceId: scope.workspaceId, prKey: item.prKey, err },
        "run-pr-outcomes: GitHub read failed",
      );
      asked(item);
      return;
    }
    if (read === "no_connection") {
      spent -= 1;
      return;
    }
    asked(item);
    if (read === "unreadable") return;
    forgeReads += 1;
    for (const c of item.group) c.row = foldForgeRead(c.row, read);
    if (read.state.state !== "merged") return;
    const repository = item.pr.repository.toLowerCase();
    const targets = revertTargetsOf(read.body, repository).filter(
      (t) => !(t.repository === repository && t.number === item.pr.number),
    );
    if (targets.length > 0)
      foundReverts.push(
        ...revertEvidenceOf({
          kind: "pull_requests",
          targets,
          mark: {
            by: item.prKey,
            at: read.state.mergedAt ?? read.state.closedAt,
            readAt: read.state.readAt,
          },
        }),
      );
  };
  const lane = async (): Promise<void> => {
    while (next < order.length && spent < OUTCOME_FORGE_READS_PER_PASS) {
      const item = order[next];
      next += 1;
      if (!item) break;
      spent += 1;
      await readOne(item);
    }
  };
  await Promise.all(Array.from({ length: FORGE_READ_CONCURRENCY }, lane));

  // Keep this pass's reverts before any row is written. The reverting pull
  // request's row settles in the same write, and the pass does not read a
  // settled pull request again, so a revert not kept first would be lost if
  // the write failed.
  await deps.saveReverts(scope, foundReverts);
  const revertsByRepository = new Map<string, RevertEvidence[]>();
  for (const e of [...keptReverts, ...foundReverts]) {
    const list = revertsByRepository.get(e.repository);
    if (list) list.push(e);
    else revertsByRepository.set(e.repository, [e]);
  }
  let reverted = 0;
  for (const c of candidates.values()) {
    const evidence =
      c.row.repository === null
        ? undefined
        : revertsByRepository.get(c.row.repository);
    if (!evidence) continue;
    const marked = withStoredReverts(c.row, evidence);
    if (marked === c.row) continue;
    c.row = marked;
    reverted += 1;
  }

  const rows: OutcomeRow[] = [];
  const withReason = (row: OutcomeRow): OutcomeRow => {
    const reason = reasons.get(row.runId) ?? null;
    return row.terminalReasonReadAt !== null && row.terminalReason === reason
      ? row
      : withTerminalReason(row, reason, now);
  };
  const runsWithPr = new Set<string>();
  for (const [key, c] of candidates) {
    runsWithPr.add(c.run.runId);
    const row = withReason(c.row);
    const before = storedByKey.get(key);
    if (!before || JSON.stringify(before) !== JSON.stringify(row)) rows.push(row);
  }
  // A run with no pull request gets its `none` row: a wrapped run with no
  // link, or a ledger run whose complete walk names none. A ledger run whose
  // walk is not complete, or whose receipts are not all named, gets nothing
  // yet.
  for (const run of runs) {
    if (runsWithPr.has(run.runId)) continue;
    const knownEmpty =
      run.runSource === "tacho" ||
      ledger.get(run.runId)?.length === 0 ||
      storedByKey.has(keyOf(run.runId, "none"));
    if (!knownEmpty) continue;
    const key = keyOf(run.runId, "none");
    const before = storedByKey.get(key);
    const row = withReason(before ?? blankOutcome(run.runId, run.runSource, null));
    if (!before || JSON.stringify(before) !== JSON.stringify(row)) rows.push(row);
  }

  const written = await deps.saveRows(scope, rows);
  // The walks are stored last. A pass that fails before here leaves them as
  // they were, and the next pass reads the same pages again. A run's rows are
  // written only from a complete walk, so the rows already written stand.
  await deps.saveReceiptWalks(
    scope,
    ledgerReads.map((r) => r.walk),
  );
  return {
    runs: runs.length,
    forgeReads,
    deferred: order.length - next + (dueLedger.length - ledgerAsked.length),
    rows: written,
    reverted,
  };
}

/** A forge answer that says the credentials cannot see the resource. */
function unreadableStatus(err: unknown): boolean {
  return (
    err instanceof GitHubApiError &&
    (err.status === 403 || err.status === 404 || err.status === 410)
  );
}

/** A read that answers null when GitHub says the credentials cannot see it. */
async function readable<T>(read: () => Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await read() };
  } catch (err) {
    if (unreadableStatus(err)) return null;
    throw err;
  }
}

function dateOrNull(value: string | null): Date | null {
  if (value === null) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The pull request's state, CI, and head branch, read with one client. */
export async function readGithubOutcome(
  client: GitHubClient,
  pr: RunPr,
  now: () => Date = () => new Date(),
): Promise<ForgeOutcome> {
  const [owner = "", repo = ""] = pr.repository.split("/");
  const found = await readable(() =>
    client.getPullRequest({ owner, repo, number: pr.number }),
  );
  if (found === null) return "unreadable";
  const pull = found.value;
  const readAt = now();
  const state: RunPrState =
    pull.state === "open" ? "open" : pull.merged ? "merged" : "closed";
  const headSha = pull.headSha;
  const checks = headSha
    ? await readable(() => client.listCiChecks({ owner, repo, ref: headSha }))
    : null;
  const branch = pull.headRef
    ? await readable(() =>
        client.getBranch({ owner, repo, branch: pull.headRef }),
      )
    : null;
  return {
    state: {
      state,
      readAt,
      closedAt: null,
      mergedAt: state === "merged" ? dateOrNull(pull.mergedAt) : null,
      mergeCommitSha: state === "merged" ? pull.mergeCommitSha : null,
      baseRef: pull.baseRef || null,
      headRef: pull.headRef || null,
      headSha,
      sourceUpdatedAt: dateOrNull(pull.updatedAt),
    },
    body: pull.body,
    // A commit with more checks than the client's ten-page bound comes back
    // `complete: false`. The checks it left out may be pending or failing, so
    // a partial read is not a verdict.
    ci:
      checks && headSha
        ? {
            state: ciStateOfRead(
              buildCiSummary(checks.value).overall,
              checks.value.complete !== false,
            ),
            headSha,
            readAt: now(),
          }
        : null,
    headBranch: branch ? { exists: branch.value !== null, readAt: now() } : null,
  };
}

const connections = schema.sourceConnections;

/** The workspace's connected GitHub sources, newest first, as `githubConnectionOf` weighs them. */
async function githubConnections(scope: OutcomeScope) {
  return withTenantDb((tx) =>
    tx
      .select({
        id: connections.id,
        deliveryConfig: connections.deliveryConfig,
        oauthAccountId: connections.oauthAccountId,
      })
      .from(connections)
      .where(
        and(
          eq(connections.orgId, scope.orgId),
          eq(connections.workspaceId, scope.workspaceId),
          eq(connections.connectorId, "github"),
          eq(connections.status, "connected"),
          isNull(connections.deletedAt),
        ),
      )
      .orderBy(desc(connections.createdAt)),
  );
}

/** The receipt an event records, or null when it is not a well-formed `provider_publish.pull_request_opened`. */
function receiptOf(event: AttemptEventReadRecord): LedgerReceipt | null {
  // The same reading as `readLedgerPrReceipts` (run-work-prs.ts), which
  // always walks from a run's first event.
  if (
    event.eventType !== "provider_publish.pull_request_opened" ||
    typeof event.payload !== "object" ||
    event.payload === null
  )
    return null;
  const payload = event.payload as Record<string, unknown>;
  if (
    typeof payload.provider_repository_id !== "string" ||
    typeof payload.pull_request_number !== "number"
  )
    return null;
  return {
    repositoryId: payload.provider_repository_id,
    number: payload.pull_request_number,
    headSha:
      typeof payload.head_commit_sha === "string"
        ? payload.head_commit_sha
        : null,
  };
}

/**
 * One pass of a run's receipt walk: the events after `afterSeq` (from the
 * first event when null), `RECEIPT_WALK_PAGE` at a time, for at most
 * `RECEIPT_WALK_PAGES` pages. `afterSeq` comes back as the `run_seq` of the
 * last event read, so the next pass resumes there. `complete` is true once a
 * page came back short, which means the walk read the run's last event.
 */
export async function walkLedgerReceipts(
  store: Pick<RunStore, "readAttemptEventsSince">,
  runId: string,
  afterSeq: string | null,
): Promise<{
  receipts: LedgerReceipt[];
  afterSeq: string | null;
  complete: boolean;
}> {
  const receipts: LedgerReceipt[] = [];
  let cursor = afterSeq;
  for (let page = 0; page < RECEIPT_WALK_PAGES; page++) {
    const events = await store.readAttemptEventsSince(
      runId,
      cursor ?? "0",
      RECEIPT_WALK_PAGE,
    );
    for (const event of events) {
      const receipt = receiptOf(event);
      if (receipt) receipts.push(receipt);
    }
    const last = events.at(-1);
    if (last !== undefined) cursor = last.runSeq;
    if (events.length < RECEIPT_WALK_PAGE)
      return { receipts, afterSeq: cursor, complete: true };
  }
  return { receipts, afterSeq: cursor, complete: false };
}

/** The walk's receipts with a new page's added, one per pull request, the first kept. */
function withReceipts(
  kept: readonly LedgerReceipt[],
  found: readonly LedgerReceipt[],
): LedgerReceipt[] {
  const out = new Map(kept.map((r) => [`${r.repositoryId}#${r.number}`, r]));
  for (const r of found) {
    const key = `${r.repositoryId}#${r.number}`;
    if (!out.has(key)) out.set(key, r);
  }
  return [...out.values()];
}

/** One ledger run's walk taken one pass further, and its pull requests once all are named. */
async function readLedgerRun(
  store: Pick<RunStore, "getRunByPublicId" | "readAttemptEventsSince">,
  repositories: ReadonlyMap<string, ConnectedRunRepository>,
  request: LedgerWalkRequest,
  now: Date,
): Promise<LedgerRunRead> {
  const tried: ReceiptWalk = {
    ...(request.walk ?? {
      runId: request.runId,
      afterSeq: null,
      complete: false,
      receipts: [],
    }),
    attemptedAt: now,
    unresolved: null,
    retryAfter: null,
  };
  const waitOn = (walk: ReceiptWalk, unresolved: UnresolvedReason) => ({
    walk: {
      ...walk,
      unresolved,
      retryAfter: new Date(now.getTime() + OUTCOME_UNRESOLVED_RETRY_MS),
    },
    prs: null,
  });
  let walk = tried;
  if (!walk.complete) {
    try {
      const run = await store.getRunByPublicId(request.runId);
      if (!run) return waitOn(tried, "run_not_found");
      const page = await walkLedgerReceipts(store, run.runId, walk.afterSeq);
      walk = {
        ...walk,
        afterSeq: page.afterSeq,
        complete: page.complete,
        receipts: withReceipts(walk.receipts, page.receipts),
      };
    } catch (err) {
      // The walk keeps the position it had, and the run waits its retry
      // time, so one run's failing read cannot fail every pass.
      logger.warn(
        { runId: request.runId, err },
        "run-pr-outcomes: ledger receipt read failed",
      );
      return waitOn(tried, "read_failed");
    }
    if (!walk.complete) return { walk, prs: null };
  }
  const prs: LedgerRunPr[] = [];
  for (const receipt of walk.receipts) {
    const repository = repositories.get(receipt.repositoryId);
    // One receipt the workspace cannot name holds back the whole run, since
    // rows for the named part would read as all of it. A reconnect names it
    // on a later try.
    if (!repository) return waitOn(walk, "repository_not_connected");
    prs.push({
      provider: "github",
      repository: `${repository.owner}/${repository.name}`.toLowerCase(),
      number: receipt.number,
      url: `${repository.url}/pull/${receipt.number}`,
      headSha: receipt.headSha,
    });
  }
  return { walk, prs };
}

/**
 * Each ledger run's receipt walk taken one pass further, and the pull
 * requests of every walk that is complete and fully named.
 */
export async function readLedgerRunPrs(
  store: Pick<RunStore, "getRunByPublicId" | "readAttemptEventsSince">,
  scope: OutcomeScope,
  runs: readonly LedgerWalkRequest[],
  now: Date,
): Promise<LedgerRunRead[]> {
  if (runs.length === 0) return [];
  const repositories = new Map(
    (await connectedRunRepositories(scope)).map((r) => [
      r.providerRepositoryId,
      r,
    ]),
  );
  const out: LedgerRunRead[] = [];
  for (const request of runs)
    out.push(await readLedgerRun(store, repositories, request, now));
  return out;
}

/**
 * The production dependencies for one pass. The GitHub client for each owner
 * is built once per pass. Everything that reads through `withTenantDb` runs
 * inside the tenant scope the runner opens.
 */
export function defaultOutcomeRefreshDeps(): OutcomeRefreshDeps {
  const ledger = ledgerStore();
  let connectionRows: ReturnType<typeof githubConnections> | null = null;
  const clients = new Map<string, Promise<GitHubClient | null>>();
  const clientFor = (scope: OutcomeScope, owner: string) => {
    let client = clients.get(owner);
    if (!client) {
      client = (async () => {
        connectionRows ??= githubConnections(scope);
        const connectionId = githubConnectionOf(await connectionRows, owner);
        if (connectionId === null) return null;
        return createGitHubClient({
          token: await resolveGitHubToken({ ...scope, connectionId }),
        });
      })();
      clients.set(owner, client);
    }
    return client;
  };
  return {
    now: () => new Date(),
    listRuns: listOutcomeRuns,
    terminalReasons: readRunTerminalReasons,
    readRows: readOutcomeRows,
    tachoLinks: readTachoRunPrLinks,
    receiptWalks: readReceiptWalks,
    ledgerPrs: (scope, runs, now) => readLedgerRunPrs(ledger, scope, runs, now),
    saveReceiptWalks,
    readForge: async (scope, pr) => {
      const owner = pr.repository.toLowerCase().split("/")[0] ?? "";
      const client = await clientFor(scope, owner);
      if (client === null) return "no_connection";
      return readGithubOutcome(client, pr);
    },
    readReverts: readRevertEvidence,
    saveReverts: saveRevertEvidence,
    saveRows: saveOutcomeRows,
  };
}
