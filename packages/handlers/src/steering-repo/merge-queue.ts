// steering-repo/merge-queue.ts: how Oxagen merges a steering PR
// (steering-repo-spec, Steering PR flow: Queue, Stamp and Merge).
//
// Oxagen merges one steering PR at a time per repository.
// At the head of the queue the PR's branch must
// hold the production branch. When it does not, Oxagen brings the branch up
// to date and runs the checks again. In the steering layout Oxagen then pushes
// one stamp commit: the `id` and `hash` of each steering record the PR changes
// and one ledger line. The squash merge is pinned to the commit that was
// checked (or stamped), and its message ends with the Oxagen-* trailers.
//
// The queue has two locks. merge_steering_pr merges on the api surface, and
// set_governance_mode merges on the mcp surface too, so two processes can
// merge the same repository at once.
//
// - Inside one process, calls for a repository wait in the order they
//   arrived, so only the call at the head of the queue reaches Postgres.
// - Across processes, that call takes a Postgres advisory lock on the
//   repository's queue key, on the shared database every process connects
//   to. A transaction holds the lock while the merge runs and releases it
//   when the merge ends, or when the process dies and its connection closes.
//
// Holding the lock keeps one database connection open per merge in
// progress. A merge waits at most a minute for another process's merge, then
// refuses with `merge_queue_busy` and nothing merged.
import { withSystemDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import {
  governanceSchema,
  resolveGovernance,
  type GovernanceSettings,
} from "@oxagen/oxagen/steering-repo/governance";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import {
  REQUIRED_CHECK_NAME,
  STEERING_ENVIRONMENT,
} from "@oxagen/oxagen/steering-repo/names";
import {
  GOVERNANCE_TOML_PATH,
  PROMOTIONS_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import type { PromotionChange } from "@oxagen/oxagen/steering-repo/promotion";
import { sql } from "drizzle-orm";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";
import {
  GOVERNANCE_PATH,
  parseGovernanceMode,
} from "../context.steering.policy";
import { logger } from "../logger";
import { assertSteeringCommit } from "./provenance";
import {
  branchScopeRefusal,
  buildLedgerLine,
  chooseLedgerTarget,
  IMPORT_RECORDS_DIR,
  IMPORT_REPLACES_PATH,
  isImportBranch,
  isStampedRecordPath,
  mergeTrailers,
  parseReplacesFile,
  stampRecordText,
} from "./stamp";

// ── The queue ────────────────────────────────────────────────────────────────

/** The last merge waiting or running on each repository, by queue key. */
const tails = new Map<string, Promise<void>>();

/** One queue per repository on its host: `github:a-intel/oxagen-core`. */
export function mergeQueueKey(repo: SteeringRepository): string {
  return `${repo.provider}:${repo.fullName.toLowerCase()}`;
}

/**
 * A lock every process that merges steering PRs can see. It runs `work` while
 * it holds the lock for `key`, and releases the lock when `work` settles.
 */
export type SharedMergeLock = <T>(
  key: string,
  work: () => Promise<T>,
) => Promise<T>;

export interface PostgresMergeLockOptions {
  /** How long a merge waits for another process's merge before it refuses. */
  waitMs?: number;
}

const MERGE_WAIT_MS = 60_000;
/** The advisory lock's key is this prefix and the queue key. */
const MERGE_LOCK_PREFIX = "steering-merge-queue:";
/** SQLSTATE lock_not_available: `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = "55P03";

/** True when `err`, or an error in its cause chain, is lock_not_available. */
function isLockTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cur !== "object" || cur === null) return false;
    const e = cur as { code?: unknown; cause?: unknown };
    if (e.code === LOCK_NOT_AVAILABLE) return true;
    cur = e.cause;
  }
  return false;
}

function mergeQueueBusy(key: string, waitMs: number): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "merge_queue_busy",
    message: `Another merge on ${key} held the merge queue for over ${Math.round(waitMs / 1000)} seconds, so nothing merged. Merge again in a minute.`,
  });
}

/**
 * The shared lock in Postgres: a transaction-scoped advisory lock on a hash
 * of the queue key, on the shared database. A wait longer than `waitMs`
 * refuses with `merge_queue_busy`, and `work` never starts.
 *
 * `work` runs inside the lock's transaction, which reads and writes no row.
 * If that transaction fails after `work` finished, for instance because the
 * connection dropped, the lock is already gone. The merge stands, so the
 * failure is logged and `work`'s own result is returned.
 */
export function postgresMergeLock(
  options: PostgresMergeLockOptions = {},
): SharedMergeLock {
  const waitMs = options.waitMs ?? MERGE_WAIT_MS;
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const held: { work?: Promise<T> } = {};
    try {
      // tenancy: global lock on the host repository's queue key; it reads and writes no row, so no orgId or workspaceId filter applies.
      await withSystemDb(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${String(waitMs)}, true)`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${MERGE_LOCK_PREFIX}${key}`}::text, 0))`,
        );
        held.work = work();
        // Hold the lock until the merge settles. Its error reaches the
        // caller below, after the lock is released.
        await held.work.then(
          () => undefined,
          () => undefined,
        );
      });
    } catch (err) {
      if (held.work === undefined) {
        throw isLockTimeout(err) ? mergeQueueBusy(key, waitMs) : err;
      }
      logger.warn(
        { err, key },
        "steering merge queue: the merge ran, but its lock's transaction failed; Postgres released the lock with the connection",
      );
    }
    const running = held.work;
    if (running === undefined) {
      throw new Error(`The merge lock for ${key} ended before the merge ran.`);
    }
    return running;
  };
}

let sharedLock: SharedMergeLock = postgresMergeLock();

/**
 * Replace the shared lock, and answer the one it replaced. Unit tests run
 * without a database, so the steering test harness swaps in a lock that only
 * runs `work`. Production never calls this.
 */
export function setSharedMergeLockForTests(
  lock: SharedMergeLock,
): SharedMergeLock {
  const before = sharedLock;
  sharedLock = lock;
  return before;
}

/**
 * Run `work` after every earlier call for the same repository has finished,
 * in this process and in every other one. Calls in one process run in the
 * order they arrived, and only the head of that queue takes the shared lock.
 * A call that throws still lets the next one run.
 */
export async function inMergeQueue<T>(
  repo: SteeringRepository,
  work: () => Promise<T>,
): Promise<T> {
  const key = mergeQueueKey(repo);
  const before = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  await before;
  try {
    return await sharedLock(key, work);
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

// ── Layout and governance ────────────────────────────────────────────────────

/**
 * Which layout the repository's production branch uses. A repository with
 * steering/governance.toml is a steering repo: its PRs are stamped and its
 * ledger is steering/promotions/. Any other repository keeps the legacy
 * layout under .oxagen/rules/, where Postgres holds the ledger and nothing
 * is stamped. The queue, the update, the re-check, the approvals, and the
 * trailers apply to both.
 */
export type SteeringLayout =
  | { layout: "steering"; mode: GovernanceMode; settings: GovernanceSettings }
  | { layout: "legacy"; mode: GovernanceMode };

function governanceUnreadable(message: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "governance_unreadable",
    message,
  });
}

/** The layout and governance mode on the production branch, or a refusal. */
export async function readSteeringLayout(
  host: SteeringHost,
  repo: SteeringRepository,
): Promise<SteeringLayout> {
  const text = await host.readFile(
    repo,
    GOVERNANCE_TOML_PATH,
    repo.defaultBranch,
  );
  if (text !== null) {
    const read = readTomlFile(text, "governance/v1", governanceSchema);
    if (!read.ok) {
      const first = read.issues[0];
      throw governanceUnreadable(
        `${GOVERNANCE_TOML_PATH}${first?.line ? ` line ${first.line}` : ""}: ${first?.message ?? "is not governance/v1"}`,
      );
    }
    const settings = resolveGovernance(read.value);
    return { layout: "steering", mode: settings.mode, settings };
  }
  const mode = parseGovernanceMode(
    await host.readFile(repo, GOVERNANCE_PATH, repo.defaultBranch),
  );
  if (typeof mode !== "string") throw governanceUnreadable(mode.error);
  return { layout: "legacy", mode };
}

// ── Health ───────────────────────────────────────────────────────────────────

/** While the repository is not healthy, Oxagen merges and publishes nothing. */
export function assertHealthy(health: RepoHealth, repo: SteeringRepository) {
  if (health === "healthy") return;
  throw new HandlerError({
    code: "conflict",
    reason: "repository_unhealthy",
    message: `${repo.fullName} is ${health}, so Oxagen merges nothing until its settings are repaired. Runs keep the last published version.`,
  });
}

// ── Approvals ────────────────────────────────────────────────────────────────

export interface MergeActor {
  userId: string;
  orgRole: string | null;
  workspaceRole: string | null;
}

/**
 * An approval a person gave in Oxagen (approve_steering_pr, ADR-267), at the
 * head they approved. The Oxagen GitHub App opens every steering PR, and
 * GitHub refuses an app's approving review of a pull request it opened, so
 * this approval lives in Oxagen and not on the host.
 */
export interface OxagenApproval {
  userId: string;
  commitSha: string;
}

/** Who approved a merge, or that its merger merged without review. */
export interface MergeApproval {
  /** Oxagen user ids, in the order the host listed them. */
  approvedBy: string[];
  withoutReview: boolean;
}

export interface ApprovalInput {
  host: SteeringHost;
  repo: SteeringRepository;
  number: number;
  mode: GovernanceMode;
  /**
   * The heads an approval counts at, oldest first. The first is the head the
   * checks passed on. Each one after it is a merge commit the queue made to
   * bring the branch up to date: its first parent is the head before it, and
   * its second is the production branch head. The PR's own diff is the same
   * at each, so an approval of one carries to the rest. An approval of any
   * other commit counts for nothing, so a push by anyone else needs a fresh
   * approval.
   */
  heads: readonly string[];
  authorUserId: string | null;
  merger: MergeActor;
  /**
   * The approvals given in Oxagen on this PR (ADR-267). Read on every call,
   * like the host's, because the queue asks again after each update.
   */
  oxagenApprovals: () => Promise<readonly OxagenApproval[]>;
  /** True when the user holds a role in the workspace or its organization. */
  isMember: (userId: string) => Promise<boolean>;
  /** True when the merger holds merge_pr_without_review (ADR-213). */
  holdsMergeWithoutReview: () => Promise<boolean>;
}

/**
 * The approvals a merge carries, or `approval_required`.
 *
 * In solo mode no approval is needed and the merger is the approver. In team
 * and regulated mode the PR needs an approval at one of `heads`, by a
 * workspace member other than the author. The approval is either a review
 * on the host by an account linked to an Oxagen user, or one given in Oxagen
 * (approve_steering_pr, ADR-267). Both pass the same rule, and a person
 * counts once. Without one, an owner of the organization or workspace, or a
 * member holding merge_pr_without_review, may still merge, and the ledger
 * and trailers record that nobody reviewed it.
 */
export async function mergeApproval(
  input: ApprovalInput,
): Promise<MergeApproval> {
  if (input.mode === "solo") {
    return { approvedBy: [input.merger.userId], withoutReview: false };
  }
  const approvedBy: string[] = [];
  const [hosted, given] = await Promise.all([
    input.host.listApprovals(input.repo, input.number),
    input.oxagenApprovals(),
  ]);
  for (const approval of [...hosted, ...given]) {
    const userId = approval.userId;
    if (userId === null || approvedBy.includes(userId)) continue;
    if (
      approval.commitSha !== null &&
      !input.heads.includes(approval.commitSha)
    )
      continue;
    if (userId === input.authorUserId) continue;
    if (!(await input.isMember(userId))) continue;
    approvedBy.push(userId);
  }
  if (approvedBy.length > 0) return { approvedBy, withoutReview: false };
  const owner =
    input.merger.orgRole === "Owner" || input.merger.workspaceRole === "Owner";
  if (owner || (await input.holdsMergeWithoutReview())) {
    return { approvedBy: [], withoutReview: true };
  }
  throw new HandlerError({
    code: "forbidden",
    reason: "approval_required",
    message: `Governance mode ${input.mode} merges a steering PR only after a workspace member other than the author approves it at ${input.heads[input.heads.length - 1]}. An owner, or a member with merge_pr_without_review, may merge without one.`,
  });
}

// ── The stamp ────────────────────────────────────────────────────────────────

export interface StampInput {
  host: SteeringHost;
  repo: SteeringRepository;
  number: number;
  branch: string;
  /** The branch head the checks passed on. It holds `main`. */
  head: string;
  /** The production branch's head the ledger continues from. */
  main: string;
  settings: GovernanceSettings;
  at: Date;
  approval: MergeApproval;
  mergedBy: string;
}

export interface StampResult {
  sha: string;
  changes: PromotionChange[];
  ledgerPath: string;
  seq: number;
  hash: string;
}

function stampRefused(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * The id each record had before the import converted it, by path, read from
 * {@link IMPORT_REPLACES_PATH} at `head`. Only an import branch may carry the
 * file, and `branchScopeRefusal` refuses it on any other branch. A branch
 * without the file names no old ids.
 */
async function importReplaces(
  input: StampInput,
  changed: readonly { path: string; status: string }[],
): Promise<Map<string, string>> {
  const file = changed.find((entry) => entry.path === IMPORT_REPLACES_PATH);
  if (!file || file.status === "removed") return new Map();
  const text = await input.host.readFile(
    input.repo,
    IMPORT_REPLACES_PATH,
    input.head,
  );
  const parsed =
    text === null
      ? { ok: false as const, message: `the file is not at ${input.head}` }
      : parseReplacesFile(text);
  if (!parsed.ok) {
    throw stampRefused(
      "replaces_unreadable",
      `${IMPORT_REPLACES_PATH} on ${input.branch} cannot be read: ${parsed.message}`,
    );
  }
  return parsed.replaces;
}

/**
 * Push the stamp commit on top of `head`: each changed steering record with
 * its `id` and `hash`, and the ledger line that records the merge. On an
 * import branch, each converted record's ledger change also names the id it
 * replaces, and the stamp commit deletes {@link IMPORT_REPLACES_PATH}, so the
 * file never reaches the production branch. An import branch that adds or
 * changes a record under {@link IMPORT_RECORDS_DIR} without naming its old id
 * is refused with `replaces_missing`. The host refuses with
 * `head_moved` when the branch is no longer at `head`.
 */
export async function stampHead(input: StampInput): Promise<StampResult> {
  const { host, repo, head } = input;
  const changed = await host.changedFiles(repo, input.main, head);
  if (changed.length === 0) {
    throw stampRefused(
      "nothing_to_merge",
      `${input.branch} changes nothing against ${repo.defaultBranch}`,
    );
  }
  const scope = branchScopeRefusal(
    input.branch,
    changed.map((file) => file.path),
  );
  if (scope) throw stampRefused(scope.reason, scope.message);
  const replaces = await importReplaces(input, changed);

  const files: { path: string; content: string | null }[] = [];
  const changes: PromotionChange[] = [];
  for (const file of changed) {
    if (file.path === IMPORT_REPLACES_PATH) {
      if (file.status !== "removed") {
        files.push({ path: IMPORT_REPLACES_PATH, content: null });
      }
      continue;
    }
    if (file.status === "removed" || !isStampedRecordPath(file.path)) {
      changes.push({ path: file.path, action: file.status });
      continue;
    }
    const text = await host.readFile(repo, file.path, head);
    if (text === null) {
      throw stampRefused(
        "record_file_missing",
        `${file.path} is not at ${head}`,
      );
    }
    const stamped = stampRecordText(text);
    if (!stamped.ok) {
      throw stampRefused(
        "stamp_refused",
        `${file.path} cannot be stamped: ${stamped.message}`,
      );
    }
    if (stamped.text !== text) {
      files.push({ path: file.path, content: stamped.text });
    }
    const old = replaces.get(file.path);
    changes.push({
      path: file.path,
      action: file.status,
      lineage: stamped.lineage,
      id: stamped.id,
      hash: stamped.hash,
      ...(old && old !== stamped.id ? { replaces: old } : {}),
    });
  }
  const unmatched = [...replaces.keys()].filter(
    (path) =>
      !changes.some((change) => change.path === path && change.id !== undefined),
  );
  if (unmatched.length > 0) {
    throw stampRefused(
      "replaces_unmatched",
      `${IMPORT_REPLACES_PATH} names an old id for ${unmatched.sort().join(", ")}, and ${input.branch} adds or changes no steering record there`,
    );
  }
  // Each record an import converts keeps its old id, so its runs follow it.
  // A batch of only skills or governance.toml adds no record there.
  if (isImportBranch(input.branch)) {
    const unnamed = changes
      .filter(
        (change) =>
          change.id !== undefined &&
          change.path.startsWith(`${IMPORT_RECORDS_DIR}/`) &&
          !replaces.has(change.path),
      )
      .map((change) => change.path);
    if (unnamed.length > 0) {
      throw stampRefused(
        "replaces_missing",
        `${IMPORT_REPLACES_PATH} names no old id for ${unnamed.sort().join(", ")}, and every record ${input.branch} adds or changes under ${IMPORT_RECORDS_DIR}/ needs one`,
      );
    }
  }

  const target = await chooseLedgerTarget({
    paths: await host.listFiles(repo, head, PROMOTIONS_DIR),
    read: (path) => host.readFile(repo, path, head),
    at: input.at,
    rotate: input.settings.rotate,
    maxLines: input.settings.max_lines,
  });
  if (!target.ok) throw stampRefused("ledger_unreadable", target.message);
  const line = buildLedgerLine({
    seq: target.seq,
    prev: target.prev,
    at: input.at,
    provider: repo.provider,
    number: input.number,
    branch: input.branch,
    mode: input.settings.mode,
    approvedBy: input.approval.approvedBy,
    mergedBy: input.mergedBy,
    withoutReview: input.approval.withoutReview,
    changes,
  });
  if (!line.ok) throw stampRefused("ledger_line_refused", line.message);
  const existing =
    target.existing === "" || target.existing.endsWith("\n")
      ? target.existing
      : `${target.existing}\n`;
  files.push({ path: target.path, content: `${existing}${line.line}` });

  const { sha } = await host.commitFiles(repo, {
    branch: input.branch,
    parent: head,
    message: `steering: stamp #${input.number}`,
    files,
  });
  return {
    sha,
    changes,
    ledgerPath: target.path,
    seq: target.seq,
    hash: line.hash,
  };
}

// ── The commit a check compares against ──────────────────────────────────────

/**
 * The commit the steering checks compare a PR's `head` with: the production
 * head `main` when the head holds it, and otherwise the newest commit the
 * branch shares with the production branch.
 *
 * The checks compare two whole trees. A branch cut before another steering
 * PR merged lacks that PR's files and the ledger line its stamp wrote. Read
 * against the production head, the branch looks like it removes those files
 * and rewrites the ledger, and the owned check fails it (#5139). Against the
 * shared commit, the checks see only what the PR changes. landSteeringPr
 * then brings the branch up to date, and the checks run again against the
 * production head, which the new head holds.
 *
 * Falls back to `main` when the two commits share no history.
 */
export async function checkBase(
  host: Pick<SteeringHost, "mergeBase">,
  repo: SteeringRepository,
  head: string,
  main: string,
): Promise<string> {
  return (await host.mergeBase(repo, head, main)) ?? main;
}

// ── Landing a PR ─────────────────────────────────────────────────────────────

/** What a re-check after an update found: whether it passed, and which checks ran. */
export interface RecheckResult {
  ok: boolean;
  checks: readonly string[];
  /** The first error the checks found, as a sentence for the refusal. */
  failure?: string | null;
}

export interface LandInput {
  host: SteeringHost;
  repo: SteeringRepository;
  number: number;
  branch: string;
  /** The head the checks passed on. */
  checkedHead: string;
  /** The checks that passed on it, by name. */
  checks: readonly string[];
  layout: SteeringLayout;
  /**
   * The approvals the merge carries at any of `heads`, or a refusal. `heads`
   * starts as the checked head. Each update that merges the production branch
   * head into the last of them adds its merge commit. Any other update starts
   * the list again at the new head. It runs before the first attempt and
   * again after each update, so the stamp and the trailers name the approvals
   * that stand on the head that merges.
   */
  approve: (heads: readonly string[]) => Promise<MergeApproval>;
  mergedBy: string;
  commitTitle: string;
  /** The published version the merge becomes. */
  version: number;
  now: () => Date;
  /** Run the checks again on a head the update produced. */
  recheck: (head: string) => Promise<RecheckResult>;
  /** How many times the production branch may move before the merge gives up. */
  maxAttempts?: number;
}

export interface Landed {
  /** The squash merge commit on the production branch. */
  commitSha: string;
  /** The branch head the merge was pinned to: the stamp commit, or the checked head. */
  mergedHead: string;
  /** The head the checks last passed on. */
  checkedHead: string;
  stamp: StampResult | null;
  /** How many times the loop ran; more than one means the production branch moved. */
  attempts: number;
}

export const LAND_ATTEMPTS = 3;

/**
 * The heads an approval counts at once an update moved the branch off the
 * last of `heads`. A merge commit whose first parent is that head and whose
 * second is `main` leaves the PR's own diff unchanged, so it joins the list.
 * Any other new head starts the list again, so it needs a fresh approval.
 */
function headsAfterUpdate(
  heads: string[],
  main: string,
  update: { headSha: string; parents: string[] | null },
): string[] {
  const last = heads[heads.length - 1];
  // The branch already held `main`: nothing moved.
  if (update.headSha === last) return heads;
  const parents = update.parents ?? [];
  const merged =
    parents.length === 2 && parents[0] === last && parents[1] === main;
  return merged ? [...heads, update.headSha] : [update.headSha];
}

/**
 * Merge one steering PR at the head of the queue.
 *
 * 1. Read the production branch. When the PR's head does not hold it, bring
 *    the branch up to date, run the checks again on the new head, and read
 *    the approvals again. An approval carries onto the new head only when
 *    that head is a merge commit of the approved head and the production
 *    branch head, so the PR's own diff is unchanged.
 * 2. In the steering layout, push the stamp commit and post the required
 *    check on it, naming the commit the checks ran on.
 * 3. Read the production branch again. When it moved, point the branch back
 *    at the checked head, dropping the stamp, and start over.
 * 4. Squash-merge pinned to the stamped (or checked) commit, with the
 *    Oxagen-Approved-By, Oxagen-Checks, and Oxagen-Version trailers.
 *
 * A merge the host refuses drops the stamp too, as does any other failure
 * after the stamp lands, so a retry starts from the head the author pushed.
 * A stamp is dropped only while the branch still points at it, so a push
 * that lands on top of the stamp stays. GitHub checks the branch and moves
 * it in one step. GitLab reads it first, so a push in the moment between the
 * read and the reset is still lost there (#4504).
 */
export async function landSteeringPr(input: LandInput): Promise<Landed> {
  const { host, repo } = input;
  const attempts = input.maxAttempts ?? LAND_ATTEMPTS;
  let head = input.checkedHead;
  let heads: string[] = [head];
  let checks = input.checks;
  let approval: MergeApproval | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const main = await host.branchHead(repo, repo.defaultBranch);
    if (main === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_missing",
        message: `${repo.fullName} has no ${repo.defaultBranch} branch`,
      });
    }
    await assertSteeringCommit(host, repo, main);
    approval ??= await input.approve(heads);
    if (!(await host.holdsCommit(repo, head, main))) {
      const update = await host.updateBranch(repo, {
        number: input.number,
        branch: input.branch,
        expectedHead: head,
        base: main,
      });
      heads = headsAfterUpdate(heads, main, update);
      head = update.headSha;
      const again = await input.recheck(head);
      if (!again.ok) {
        throw new HandlerError({
          code: "conflict",
          reason: "checks_failed",
          message: `${repo.defaultBranch} moved, and the checks failed on ${head} after Oxagen brought ${input.branch} up to date.${again.failure ? ` ${again.failure}` : ""} Fix the branch and run the checks again.`,
        });
      }
      checks = again.checks;
      // A reviewer may withdraw while the update runs, and the host may drop
      // an approval when the branch moves.
      approval = await input.approve(heads);
    }

    // Any failure after the stamp lands drops it, so the branch goes back to
    // the head the checks passed on and a retry does not refuse head_moved.
    let stamp: StampResult | null = null;
    try {
      if (input.layout.layout === "steering") {
        const at = input.now();
        stamp = await stampHead({
          host,
          repo,
          number: input.number,
          branch: input.branch,
          head,
          main,
          settings: input.layout.settings,
          at,
          approval,
          mergedBy: input.mergedBy,
        });
        await host.reportCheckRun(repo, {
          name: REQUIRED_CHECK_NAME,
          headSha: stamp.sha,
          conclusion: "success",
          title: "Steering checks passed",
          summary: `The checks passed on ${head}. This commit adds only Oxagen's stamp: the id and hash of each changed steering record, and ledger line ${stamp.seq} in ${stamp.ledgerPath}.`,
          startedAt: at.toISOString(),
          completedAt: input.now().toISOString(),
        });
      }

      if ((await host.branchHead(repo, repo.defaultBranch)) !== main) {
        if (
          stamp &&
          !(await host.resetBranch(repo, input.branch, {
            from: stamp.sha,
            to: head,
          }))
        ) {
          // The branch moved, so the catch below has no stamp to drop.
          stamp = null;
          throw stampedBranchMoved(input.branch, input.number);
        }
        continue;
      }

      const mergedHead = stamp?.sha ?? head;
      const trailers = mergeTrailers({
        approvedBy: approval.approvedBy,
        withoutReviewBy: approval.withoutReview ? input.mergedBy : null,
        checks,
        version: input.version,
      });
      const commitSha = (
        await host.mergePullRequest(repo, {
          number: input.number,
          commitTitle: input.commitTitle,
          sha: mergedHead,
          commitMessage: trailers,
          base: main,
        })
      ).sha;
      return {
        commitSha,
        mergedHead,
        checkedHead: head,
        stamp,
        attempts: attempt,
      };
    } catch (err) {
      if (stamp)
        await dropStampQuietly(host, repo, input.branch, stamp.sha, head);
      throw err;
    }
  }
  throw new HandlerError({
    code: "conflict",
    reason: "production_branch_moving",
    message: `${repo.defaultBranch} moved ${attempts} times while Oxagen was merging #${input.number}. Merge again.`,
  });
}

/**
 * Point the branch back at the checked head, dropping the stamp, on the way
 * out of a failure. The reset runs only while the branch is still at the
 * stamp, so a push Oxagen did not make is left alone. It logs and never
 * throws.
 */
async function dropStampQuietly(
  host: SteeringHost,
  repo: SteeringRepository,
  branch: string,
  stamp: string,
  head: string,
): Promise<void> {
  try {
    if (!(await host.resetBranch(repo, branch, { from: stamp, to: head }))) {
      logger.warn(
        { branch, stamp, head },
        "steering merge queue: the branch moved after the stamp, so Oxagen left it; the stamp commit stays on the branch until someone removes it",
      );
    }
  } catch (err) {
    logger.warn(
      { err, branch, head },
      "steering merge queue: the stamp commit could not be dropped; the next merge refuses head_moved until the branch is reset",
    );
  }
}

/** A push reached the branch after the stamp, so the stamp stays under it. */
function stampedBranchMoved(branch: string, number: number): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "head_moved",
    message: `${branch} moved after Oxagen stamped it, so Oxagen left the branch alone. Remove the commit "steering: stamp #${number}" from the branch, then run the checks and merge again.`,
  });
}

// ── After the merge ──────────────────────────────────────────────────────────

/**
 * Record a publish as a deployment of the published commit to the steering
 * environment. The description is `Steering version N from #M`, or
 * `Steering version N` when no pull request is known, as for a version the
 * repository sync publishes. The publish has already landed, so a refusal is
 * logged and answered as null, never thrown.
 */
export async function recordPublishDeployment(
  host: SteeringHost,
  repo: SteeringRepository,
  args: { sha: string; version: number; number?: number },
): Promise<string | null> {
  const from = args.number === undefined ? "" : ` from #${args.number}`;
  try {
    const { url } = await host.recordDeployment(repo, {
      sha: args.sha,
      ref: repo.defaultBranch,
      environment: STEERING_ENVIRONMENT,
      description: `Steering version ${args.version}${from}`,
    });
    return url;
  } catch (err) {
    logger.warn(
      {
        err,
        repository: repo.fullName,
        sha: args.sha,
        pr: args.number ?? null,
      },
      "steering merge queue: published, but the host refused the deployment record",
    );
    return null;
  }
}

// ── Revert ───────────────────────────────────────────────────────────────────

export interface RevertInput {
  host: SteeringHost;
  repo: SteeringRepository;
  /** The merged steering PR. */
  number: number;
  /** Its squash merge commit on the production branch. */
  mergeCommit: string;
  /** The production branch's commit just before that merge. */
  before: string;
  /** The merged PR's branch, whose prefix the revert branch keeps. */
  branch: string;
}

/**
 * Open a steering PR that undoes a merged one: every path the merge changed
 * goes back to what it held before the merge. The ledger line the merge added
 * stays, because the ledger only grows; the revert's own merge adds the line
 * that records the undo. The revert goes through the queue like any other
 * steering PR.
 */
export async function openRevertPr(
  input: RevertInput,
): Promise<{
  number: number;
  htmlUrl: string;
  branch: string;
  /** Every path the revert changes. */
  paths: string[];
}> {
  const { host, repo } = input;
  const changed = (
    await host.changedFiles(repo, input.before, input.mergeCommit)
  ).filter((file) => !file.path.startsWith(`${PROMOTIONS_DIR}/`));
  if (changed.length === 0) {
    throw new HandlerError({
      code: "conflict",
      reason: "nothing_to_revert",
      message: `#${input.number} changed nothing to revert`,
    });
  }
  const main = await host.branchHead(repo, repo.defaultBranch);
  if (main === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "production_branch_missing",
      message: `${repo.fullName} has no ${repo.defaultBranch} branch`,
    });
  }
  const files: { path: string; content: string | null }[] = [];
  for (const file of changed) {
    files.push({
      path: file.path,
      content:
        file.status === "added"
          ? null
          : await host.readFile(repo, file.path, input.before),
    });
  }
  const slash = input.branch.indexOf("/");
  const prefix = slash > 0 ? input.branch.slice(0, slash) : "steering";
  const branch = `${prefix}/revert-${input.number}`;
  await host.ensureBranch(repo, branch, repo.defaultBranch, {
    exclusive: true,
  });
  const head = await host.branchHead(repo, branch);
  await host.commitFiles(repo, {
    branch,
    parent: head ?? main,
    message: `steering: revert #${input.number}`,
    files,
  });
  const pr = await host.openPullRequest(repo, {
    title: `Revert steering PR #${input.number}`,
    head: branch,
    base: repo.defaultBranch,
    body: `This steering PR undoes #${input.number} (${input.mergeCommit}). It merges through the queue like any other steering PR.`,
  });
  return { ...pr, branch, paths: files.map((file) => file.path) };
}
