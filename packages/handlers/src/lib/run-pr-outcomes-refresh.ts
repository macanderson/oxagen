// The hourly refresh of `cost.run_pr_outcomes` for one workspace (#4491).
//
// For each sealed run in the trailing 30 days, the pass:
//
//   1. names the pull requests the run opened: the links a wrapped run's
//      record holds (`tacho.run_pull_requests`), and the
//      `provider_publish.pull_request_opened` receipts a ledger run recorded,
//   2. reads from GitHub the state, head commit CI, and head branch of each
//      pull request whose row is not settled, at most 60 per pass, oldest
//      read first,
//   3. writes the rows that changed, with the run's terminal reason on each,
//   4. marks reverted the pull requests a merged pull request's body names
//      (`Reverts owner/repo#N`), and
//   5. gives a run that opened no pull request one `none` row that carries
//      its terminal reason.
//
// A human revert of a run's pull request reaches the table through the
// GitHub deliveries (functions/cost.run-pr-outcomes.ts), not through this
// pass. A GitLab merge request keeps the state its link holds, since the pass
// reads only GitHub.
import {
  blankOutcome,
  ciStateOf,
  type CiRead,
  listOutcomeRuns,
  markPullRequestsReverted,
  needsForgeRead,
  OUTCOME_FORGE_READS_PER_PASS,
  type OutcomeRow,
  type OutcomeRun,
  type OutcomeScope,
  type PrRef,
  type PrStateRead,
  prKeyOf,
  readOutcomeRows,
  readRunTerminalReasons,
  readTachoRunPrLinks,
  type RevertMark,
  revertTargetsOf,
  type RunPr,
  type RunPrState,
  saveOutcomeRows,
  type TachoPrLink,
  withCiRead,
  withHeadBranchRead,
  withStateRead,
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
import type { RunStore } from "@oxagen/run-ledger";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "../logger";
import { buildCiSummary } from "./ci-status";
import { githubConnectionOf } from "./run-pull-request-backfill";
import { ledgerStore } from "./run-read";
import { connectedRunRepositories } from "./run-work";
import { readLedgerPrReceipts } from "./run-work-prs";

/** Ledger runs whose receipts one pass reads. A run's receipts are read once, when it has no row yet. */
export const OUTCOME_LEDGER_READS_PER_PASS = 100;

/** GitHub reads one pass runs at a time. */
const FORGE_READ_CONCURRENCY = 6;

/** A pull request a ledger run's receipt names, with the head commit it recorded. */
export interface LedgerRunPr extends RunPr {
  headSha: string | null;
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
  /**
   * Per ledger run, the pull requests its receipts name. A run is absent when
   * its receipts could not all be named: a receipt names a repository the
   * workspace no longer connects, or the walk stopped at its bound with none.
   */
  ledgerPrs(
    scope: OutcomeScope,
    runIds: readonly string[],
  ): Promise<Map<string, LedgerRunPr[]>>;
  readForge(scope: OutcomeScope, pr: RunPr): Promise<ForgeOutcome>;
  saveRows(scope: OutcomeScope, rows: readonly OutcomeRow[]): Promise<number>;
  markReverted(
    scope: OutcomeScope,
    targets: readonly PrRef[],
    mark: RevertMark,
  ): Promise<number>;
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
  /** The oldest state read among the rows, or 0 for a row never read. */
  readAt: number;
  group: Candidate[];
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
  const [reasons, stored, links] = await Promise.all([
    deps.terminalReasons(scope, runs),
    deps.readRows(scope, runIds),
    deps.tachoLinks(
      scope,
      runs.filter((r) => r.runSource === "tacho").map((r) => r.runId),
    ),
  ]);
  const storedByKey = new Map(stored.map((r) => [keyOf(r.runId, r.prKey), r]));
  const runsWithRows = new Set(stored.map((r) => r.runId));

  // A sealed ledger run's receipts do not change, so they are read once:
  // while the run has no row.
  const unseenLedger = runs
    .filter((r) => r.runSource === "ledger" && !runsWithRows.has(r.runId))
    .map((r) => r.runId);
  const ledgerRead = unseenLedger.slice(0, OUTCOME_LEDGER_READS_PER_PASS);
  const ledger = await deps.ledgerPrs(scope, ledgerRead);

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

  // One GitHub read per pull request, however many runs name it, oldest
  // read first so a backlog past the cap rotates. A pull request in a
  // repository no GitHub source reads costs no API call, so it does not
  // count against the cap.
  const due = new Map<string, DueRead>();
  for (const c of candidates.values()) {
    if (c.pr.provider !== "github" || !needsForgeRead(c.row)) continue;
    const readAt = c.row.prStateReadAt?.getTime() ?? 0;
    const found = due.get(c.row.prKey);
    if (found) {
      found.group.push(c);
      found.readAt = Math.min(found.readAt, readAt);
    } else due.set(c.row.prKey, { prKey: c.row.prKey, pr: c.pr, readAt, group: [c] });
  }
  const order = [...due.values()].sort((a, b) => a.readAt - b.readAt);
  const reverts: { targets: PrRef[]; mark: RevertMark }[] = [];
  let forgeReads = 0;
  let spent = 0;
  let next = 0;
  const readOne = async (item: DueRead): Promise<void> => {
    let read: ForgeOutcome;
    try {
      read = await deps.readForge(scope, item.pr);
    } catch (err) {
      logger.warn(
        { workspaceId: scope.workspaceId, prKey: item.prKey, err },
        "run-pr-outcomes: GitHub read failed",
      );
      return;
    }
    if (read === "no_connection") {
      spent -= 1;
      return;
    }
    if (read === "unreadable") return;
    forgeReads += 1;
    for (const c of item.group) c.row = foldForgeRead(c.row, read);
    if (read.state.state !== "merged") return;
    const repository = item.pr.repository.toLowerCase();
    const targets = revertTargetsOf(read.body, repository).filter(
      (t) => !(t.repository === repository && t.number === item.pr.number),
    );
    if (targets.length > 0)
      reverts.push({
        targets,
        mark: {
          by: item.prKey,
          at: read.state.mergedAt ?? read.state.closedAt,
          readAt: read.state.readAt,
        },
      });
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
  // link, or a ledger run whose receipts name none. A ledger run whose
  // receipts were not read, or not all named, gets nothing yet.
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
  let reverted = 0;
  for (const r of reverts)
    reverted += await deps.markReverted(scope, r.targets, r.mark);
  return {
    runs: runs.length,
    forgeReads,
    deferred:
      order.length - next + (unseenLedger.length - ledgerRead.length),
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
    ci:
      checks && headSha
        ? {
            state: ciStateOf(buildCiSummary(checks.value).overall),
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

/** The named pull requests of each ledger run, from its receipts and the workspace's repositories. */
export async function readLedgerRunPrs(
  store: Pick<RunStore, "getRunByPublicId" | "readAttemptEventsSince">,
  scope: OutcomeScope,
  runIds: readonly string[],
): Promise<Map<string, LedgerRunPr[]>> {
  const out = new Map<string, LedgerRunPr[]>();
  if (runIds.length === 0) return out;
  const repositories = new Map(
    (await connectedRunRepositories(scope)).map((r) => [
      r.providerRepositoryId,
      r,
    ]),
  );
  for (const publicId of runIds) {
    const run = await store.getRunByPublicId(publicId);
    if (!run) continue;
    const { receipts, complete } = await readLedgerPrReceipts(store, run.runId);
    const prs: LedgerRunPr[] = [];
    let unnamed = false;
    for (const receipt of receipts) {
      const repository = repositories.get(receipt.repositoryId);
      if (!repository) {
        unnamed = true;
        continue;
      }
      prs.push({
        provider: "github",
        repository: `${repository.owner}/${repository.name}`.toLowerCase(),
        number: receipt.number,
        url: `${repository.url}/pull/${receipt.number}`,
        headSha: receipt.headSha,
      });
    }
    if (prs.length === 0 && (unnamed || !complete)) continue;
    out.set(publicId, prs);
  }
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
    ledgerPrs: (scope, runIds) => readLedgerRunPrs(ledger, scope, runIds),
    readForge: async (scope, pr) => {
      const owner = pr.repository.toLowerCase().split("/")[0] ?? "";
      const client = await clientFor(scope, owner);
      if (client === null) return "no_connection";
      return readGithubOutcome(client, pr);
    },
    saveRows: saveOutcomeRows,
    markReverted: markPullRequestsReverted,
  };
}
