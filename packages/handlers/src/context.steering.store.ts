// context.steering.store.ts — the Postgres seam under the steering handlers
// (ADR-061): the published registry (agent.steering_records and its versions),
// the promotions ledger, the proposals and the appended records. Every
// handler takes a `SteeringStore`; this file is the one that runs SQL, inside
// the tenant scope the kernel entered. The tests run the handlers against the
// in-memory store in context.steering.test-support.ts.
import {
  ambientPlaneKey,
  STEERING_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  isUniqueViolation,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { steeringRecordLabel } from "@oxagen/oxagen/steering-record-label";
import { readRecordFile } from "./context.steering.file";
import { HandlerError } from "@oxagen/oxagen";
import {
  checkFindingSchema,
  type CheckFinding,
  type CheckResult,
  type ProposalStatus,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import {
  appendPromotion,
  appendVersion,
  lockWorkspacePublication,
} from "./context.steering.publication";

interface SteeringScope {
  orgId: string;
  workspaceId: string;
}

export type ProposalRow = Omit<
  typeof schema.steeringProposals.$inferSelect,
  "checks" | "checkFindings" | "title" | "label"
> & {
  checks: CheckResult[];
  /**
   * What the latest check run found on the head (#4518, ADR-267). Every row
   * the store reads carries it; a row built in a test may leave it out, which
   * reads as none.
   */
  checkFindings?: CheckFinding[];
  title?: string | null;
  label?: string | null;
};

/**
 * One approval a person gave in Oxagen (approve_steering_pr, ADR-267): who,
 * and the PR head they approved.
 */
export interface RecordedApproval {
  userId: string;
  commitSha: string;
}

type ProposalInsert = Pick<
  ProposalRow,
  | "orgId"
  | "workspaceId"
  | "lineageId"
  | "kind"
  | "force"
  | "constraintEffect"
  | "sharingScope"
  | "statement"
  | "rationale"
  | "source"
  | "supportRuns"
  | "supportAgents"
  | "supportingRecordIds"
  | "evidenceLinks"
  | "createdById"
> & {
  title?: string | null;
  label?: string | null;
} & Partial<
    Pick<
      ProposalRow,
      | "status"
      | "governanceMode"
      | "provider"
      | "repository"
      | "baseRef"
      | "branch"
      | "path"
      | "prNumber"
      | "prUrl"
      | "headSha"
      | "checks"
    >
  >;

/** The columns a handler may change after insert. */
type ProposalPatch = Partial<
  Pick<
    ProposalRow,
    | "status"
    | "governanceMode"
    | "provider"
    | "repository"
    | "baseRef"
    | "branch"
    | "path"
    | "prNumber"
    | "prUrl"
    | "headSha"
    | "stampedRecordId"
    | "recordHash"
    | "checks"
    | "checkFindings"
    | "dismissedAt"
    | "dismissedReason"
    | "updatedById"
    | "mergeClaimedAt"
  >
>;

/**
 * Guards on a proposal write, beyond its status. `headSha` ties the write to
 * the checks that ran on that head. `noClaimSince` refuses a proposal a merge
 * claimed after that instant (see MERGE_CLAIM_SECONDS), so nothing else moves
 * it while the merge lands. `claimedAt` applies the write only while the
 * merge claim is still exactly that instant: the claim the caller wrote.
 */
export interface ProposalGuard {
  headSha?: string;
  noClaimSince?: Date;
  /**
   * The claim's instant is its owner (#4567). Another merge can claim the row
   * only once this claim has lapsed, ten minutes later, so two claims never
   * share an instant, and a call that outlived its claim cannot clear a newer
   * one.
   */
  claimedAt?: Date;
}

export type PublishedRecordRow = Omit<
  typeof schema.steeringRecords.$inferSelect,
  "label"
> & {
  label?: string | null;
  version: number | null;
  checksum: string | null;
};

/**
 * What one record has actually done, rolled up over the context-use appends
 * the runs wrote (spec §9 kinds `context_use` and `context_use_feedback`).
 *
 * Both counts are DISTINCT RUNS, not appends: a run that renders the same
 * record into eight turns used it once, and counting the turns would let a
 * chatty run outvote eight quiet ones. The run comes out of the append's
 * `source_refs`, where a frame ref is `frame:<run>/<seq>`.
 *
 * The whole thing is nullable, and the null is the point: a workspace whose
 * runs have never written a context-use append has no rollup, which is a
 * different fact from a record nothing used. Reporting the first as `0` would
 * tell a reader that the rule they are looking at was ignored, when the truth
 * is that nothing is counting.
 */
export interface RecordEffect {
  /** Runs that rendered this record into their bundle. */
  rendered: number;
  /** Runs that reported back on it — §9's `context_use_feedback`. */
  cited: number;
}

interface PublishedRecordVersion {
  publicId: string;
  version: number;
  checksum: string;
  isLatest: boolean;
  publishedAt: Date | null;
}

export type AppendRow = typeof schema.contextAppends.$inferSelect;

type AppendInsert = Pick<
  AppendRow,
  | "orgId"
  | "workspaceId"
  | "kind"
  | "lineageId"
  | "statement"
  | "sharingScope"
  | "recordHash"
  | "sourceRefs"
  | "evidenceLinks"
  | "proposalId"
  | "createdById"
>;

interface RecordFilter {
  kind?: string;
  sharingScope?: string;
  status?: string;
  lineageId?: string;
}

export interface Page {
  limit: number;
  offset: number;
}

interface PublishMergeInput {
  scope: SteeringScope;
  proposal: ProposalRow;
  /** The committed file's text: the version body. */
  body: string;
  /** SHA-256 hex over the body (the registry's immutability checksum). */
  checksum: string;
  commitSha: string;
  path: string;
  mergedAt: Date;
  mergedByUserId: string | null;
  /** The governance mode the merge ran under, recorded as the ledger's policy version. */
  policyVersion: string;
}

/** A governance proposal's merge (#4795): the commit and the approver. */
interface MergeGovernanceInput {
  proposal: ProposalRow;
  commitSha: string;
  mergedAt: Date;
  mergedByUserId: string;
}

/**
 * A steering PR proposal's merge (#5122, ADR-265): the commit, the merger,
 * and the registry records whose file the merge deleted.
 */
interface MergeSteeringPrInput {
  scope: SteeringScope;
  proposal: ProposalRow;
  commitSha: string;
  mergedAt: Date;
  mergedByUserId: string;
  /** The governance mode the merge ran under, recorded on each retirement. */
  policyVersion: string;
  /**
   * The lineages of the records to retire. Only an active record retires,
   * so a lineage the registry does not hold, or holds retired, is skipped.
   */
  retire: readonly string[];
}

interface MergeSteeringPrResult {
  proposal: ProposalRow;
  /** The lineages this merge retired, in the order `retire` named them. */
  retired: string[];
}

interface PublishMergeResult {
  recordId: string;
  recordPublicId: string;
  versionId: string;
  version: number;
  promotion: { id: string; publicId: string; seq: number; chainDigest: string };
  /** The ledger length before this promotion event. */
  ledgerBefore: number;
}

export interface SteeringStore {
  insertProposal(
    values: ProposalInsert,
    options?: { createOnly: boolean },
  ): Promise<ProposalRow>;
  findProposal(
    scope: SteeringScope,
    publicId: string,
  ): Promise<ProposalRow | null>;
  /** Another proposal with an open PR on this lineage, if any. */
  findOpenPrOnLineage(
    scope: SteeringScope,
    lineageId: string,
    excludingId: string,
  ): Promise<ProposalRow | null>;
  listProposals(
    scope: SteeringScope,
    filter: {
      status?: string;
      /** Any of these statuses; narrows with `status` when both are set. */
      statuses?: readonly string[];
      lineageId?: string;
    },
    page: Page,
  ): Promise<{ rows: ProposalRow[]; total: number }>;
  /**
   * Apply the patch only while the proposal's status is one of `from` and,
   * with `guard`, its head is still `guard.headSha` and no merge claimed it
   * after `guard.noClaimSince`. A proposal another call moved on is left as
   * it is, and the write throws `conflict` with the reason
   * `proposal_<its status>`. It throws `head_moved` when only the head
   * differs, and `merge_in_progress` when only a merge's claim stands.
   */
  updateProposal(
    id: string,
    patch: ProposalPatch,
    from: readonly ProposalStatus[],
    guard?: ProposalGuard,
  ): Promise<ProposalRow>;
  /**
   * Set aside `prior` and insert its replacement in one transaction, so a
   * lineage never loses its open proposal to a write that failed halfway
   * (#4795). `prior` moves as updateProposal would move it, and a refusal
   * there inserts nothing.
   */
  replaceProposal(
    prior: {
      id: string;
      patch: ProposalPatch;
      from: readonly ProposalStatus[];
      guard?: ProposalGuard;
    },
    values: ProposalInsert,
  ): Promise<ProposalRow>;

  listRecords(
    scope: SteeringScope,
    filter: RecordFilter,
    page: Page,
  ): Promise<{ rows: PublishedRecordRow[]; total: number }>;
  findRecord(
    scope: SteeringScope,
    idOrLineage: string,
  ): Promise<{
    record: PublishedRecordRow;
    versions: PublishedRecordVersion[];
    publishedBy: { proposalPublicId: string; prUrl: string | null } | null;
  } | null>;
  /**
   * The effect counters for one lineage, or null when this workspace has no
   * context-use rollup at all. See `RecordEffect` for why the absence is a
   * case of its own rather than a row of zeros.
   */
  recordEffect(
    scope: SteeringScope,
    lineageId: string,
  ): Promise<RecordEffect | null>;
  /** The active records in the registry, for the conflict check. */
  listActiveRecords(scope: SteeringScope): Promise<PublishedRecordRow[]>;
  /** The promotions ledger length for the workspace: its steering version. */
  ledgerLength(scope: SteeringScope): Promise<number>;
  /**
   * The newest publishing commit on the production branch, for the steering
   * freshness check: a developer's checkout that cannot reach this commit is
   * reading records that are no longer the ones in force. Null until a
   * steering PR has merged (a record published through
   * `publish_steering_record` carries no commit).
   */
  latestPublication(scope: SteeringScope): Promise<{
    commitSha: string;
    /**
     * Every distinct commit published at the newest instant, `commitSha`
     * among them. GitHub reports a merge to the second, so two merges can
     * share one, and no column here says which landed later on the branch.
     * The store does not guess. It hands back all of them, and a checkout is
     * current only when it can reach each one: git knows the ancestry.
     */
    commitShas: string[];
    publishedAt: Date;
  } | null>;
  /**
   * `ledgerLength` and `latestPublication` in one transaction, for the
   * freshness read: a publication committing between two independent reads
   * could pair the new steering version with the old `headCommit`, and a
   * checkout stalled at that old commit would then read as current under
   * the new version. One transaction gives both counts the same snapshot.
   */
  versionAndPublication(scope: SteeringScope): Promise<{
    version: number;
    publication: {
      commitSha: string;
      commitShas: string[];
      publishedAt: Date;
    } | null;
  }>;

  /** Idempotent on (workspace, record_hash): `appended` is false on a repeat. */
  insertAppend(
    values: AppendInsert,
  ): Promise<{ row: AppendRow; appended: boolean }>;
  findAppend(scope: SteeringScope, publicId: string): Promise<AppendRow | null>;
  findAppendByHash(
    scope: SteeringScope,
    recordHash: string,
  ): Promise<AppendRow | null>;
  /** The proposal an append references, by uuid, for get_record. */
  findProposalById(id: string): Promise<ProposalRow | null>;
  /** The public ids a merged proposal's uuids point at, for the PR view. */
  mergedRefs(
    row: ProposalRow,
  ): Promise<{ promotionEventPublicId: string; recordPublicId: string } | null>;
  /**
   * The display names of these users, for the steering PR page's raised,
   * merged and closed lines, read only for members of the organization so a
   * name never crosses an organization boundary. A user with no display
   * name, no row or no membership is left out, and the page names them
   * generically rather than by email.
   */
  userNames(
    scope: SteeringScope,
    userIds: readonly string[],
  ): Promise<Map<string, string>>;

  /**
   * The publication, in one transaction: upsert the registry record and its
   * new version, append the promotion event to the hash-chained ledger, and
   * move the proposal from `checks_passed` to `merged`. A proposal no longer
   * at `checks_passed` (a concurrent call published it) rolls the whole
   * transaction back with `already_merged`.
   */
  publishMerge(input: PublishMergeInput): Promise<PublishMergeResult>;
  /**
   * Move a governance proposal from `checks_passed` to `merged`, with its
   * commit and approver, and clear its merge claim. It publishes no record
   * and appends no promotion event: `steering_promotions` keeps one chain per
   * record. A proposal no longer at `checks_passed` throws `already_merged`.
   */
  mergeGovernance(input: MergeGovernanceInput): Promise<ProposalRow>;
  /**
   * Move a steering PR proposal from `checks_passed` to `merged`, with its
   * commit and merger, and clear its merge claim (#5122). In the same
   * transaction, retire each active record `retire` names: its status becomes
   * `retired` at the merge commit, and a `retire` promotion event joins its
   * chain. A proposal no longer at `checks_passed` throws `already_merged`
   * and retires nothing.
   */
  mergeSteeringPr(input: MergeSteeringPrInput): Promise<MergeSteeringPrResult>;
  /**
   * Record that `userId` approved the proposal's PR at `commitSha` (ADR-267).
   * Approving the same head twice writes nothing the second time.
   */
  recordApproval(input: {
    scope: SteeringScope;
    proposalId: string;
    userId: string;
    commitSha: string;
  }): Promise<void>;
  /** The approvals given in Oxagen on one proposal, oldest first. */
  listApprovals(
    scope: SteeringScope,
    proposalId: string,
  ): Promise<RecordedApproval[]>;
}

/** A guarded proposal write found the proposal at `status`. */
export function proposalMoved(publicId: string, status: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: `proposal_${status}`,
    message: `Proposal ${publicId} is ${status}`,
  });
}

/** A write tied to the checks on `expected` found the proposal at another head. */
export function headMoved(
  publicId: string,
  headSha: string | null,
  expected: string,
): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "head_moved",
    message: `Proposal ${publicId} moved to ${headSha ?? "no commit"} while the checks ran on ${expected}`,
  });
}

/**
 * How long a merge's claim on a proposal stands (#4504). `merge_steering_pr`
 * claims the proposal before it stamps the pull request, and clears the claim
 * when it publishes or when the host did not merge. Until then a check rerun,
 * a dismissal, and the repository sync leave the proposal alone, so the merge
 * can move it to `merged` once the host has merged. A merge that crashed
 * holds the claim until it lapses: ten minutes is well past the longest land
 * the queue makes, and short enough for a person to retry the same day.
 */
export const MERGE_CLAIM_SECONDS = 600;

/** The instant before which a merge's claim has lapsed. */
export function claimCutoff(now: Date): Date {
  return new Date(now.getTime() - MERGE_CLAIM_SECONDS * 1000);
}

/** True while a merge's claim on the proposal stands at `now`. */
export function mergeClaimed(
  row: Pick<ProposalRow, "mergeClaimedAt">,
  now: Date,
): boolean {
  return (
    row.mergeClaimedAt !== null &&
    row.mergeClaimedAt.getTime() > claimCutoff(now).getTime()
  );
}

/** A write found the proposal claimed by a merge that is still landing. */
export function mergeInProgress(
  publicId: string,
  claimedAt: Date | null,
): HandlerError {
  const lapses = claimedAt
    ? new Date(claimedAt.getTime() + MERGE_CLAIM_SECONDS * 1000).toISOString()
    : "ten minutes after the merge started";
  return new HandlerError({
    code: "conflict",
    reason: "merge_in_progress",
    message: `Proposal ${publicId} is being merged. Try again when the merge finishes. If the merge failed, try again after ${lapses}.`,
  });
}

/** The publication found the proposal past `checks_passed`. */
export function alreadyMerged(proposalPublicId: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "already_merged",
    message: `${proposalPublicId} was published by another call`,
  });
}

/**
 * Why a guarded proposal write matched no row, from the row as it now reads.
 * The status comes first, then the head, then a merge's claim. The memory
 * store in the tests answers through this too, so both stores refuse alike.
 */
export function refusedWrite(
  current: Pick<
    ProposalRow,
    "publicId" | "status" | "headSha" | "mergeClaimedAt"
  >,
  from: readonly ProposalStatus[],
  guard: ProposalGuard | undefined,
): HandlerError {
  if (!from.includes(current.status as ProposalStatus))
    return proposalMoved(current.publicId, current.status);
  if (guard?.headSha !== undefined && current.headSha !== guard.headSha)
    return headMoved(current.publicId, current.headSha, guard.headSha);
  if (
    guard?.noClaimSince !== undefined &&
    current.mergeClaimedAt !== null &&
    current.mergeClaimedAt.getTime() > guard.noClaimSince.getTime()
  )
    return mergeInProgress(current.publicId, current.mergeClaimedAt);
  if (
    guard?.claimedAt !== undefined &&
    current.mergeClaimedAt !== null &&
    current.mergeClaimedAt.getTime() !== guard.claimedAt.getTime()
  )
    return mergeInProgress(current.publicId, current.mergeClaimedAt);
  return proposalMoved(current.publicId, current.status);
}

const asChecks = (v: unknown): CheckResult[] =>
  Array.isArray(v) ? (v as CheckResult[]) : [];

function toProposal(
  row: typeof schema.steeringProposals.$inferSelect,
): ProposalRow {
  return {
    ...row,
    checks: asChecks(row.checks),
    checkFindings: asFindings(row.checkFindings),
  };
}

/**
 * The stored findings, each entry checked against the contract's shape. An
 * entry that does not read is dropped, so a row written by an older build
 * never fails the read.
 */
export function asFindings(value: unknown): CheckFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const read = checkFindingSchema.safeParse(entry);
    return read.success ? [read.data] : [];
  });
}

function scoped(scope: SteeringScope) {
  return and(
    eq(schema.steeringProposals.orgId, scope.orgId),
    eq(schema.steeringProposals.workspaceId, scope.workspaceId),
  );
}

const OPEN_PR_STATUSES = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

const recordColumns = {
  ...getTableColumns(schema.steeringRecords),
  version: schema.steeringRecordVersions.versionNumber,
  checksum: schema.steeringRecordVersions.checksum,
};

export const postgresSteeringStore: SteeringStore = {
  async insertProposal(values, options) {
    return withTenantDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${values.workspaceId}:${values.lineageId.toLowerCase()}`}, 0))`,
      );
      if (options?.createOnly) {
        const [record] = await tx
          .select({ id: schema.steeringRecords.id })
          .from(schema.steeringRecords)
          .where(
            and(
              eq(schema.steeringRecords.orgId, values.orgId),
              eq(schema.steeringRecords.workspaceId, values.workspaceId),
              eq(schema.steeringRecords.slug, values.lineageId),
            ),
          )
          .limit(1);
        const [proposal] = await tx
          .select({ id: schema.steeringProposals.id })
          .from(schema.steeringProposals)
          .where(
            and(
              eq(schema.steeringProposals.orgId, values.orgId),
              eq(schema.steeringProposals.workspaceId, values.workspaceId),
              eq(schema.steeringProposals.lineageId, values.lineageId),
            ),
          )
          .limit(1);
        if (record || proposal)
          throw new HandlerError({
            code: "conflict",
            reason: "clone_name_taken",
            message:
              "This slug already belongs to a record or a proposal. Choose another slug.",
          });
      }
      const [row] = await tx
        .insert(schema.steeringProposals)
        .values(values)
        .returning();
      if (!row)
        throw new Error("[context.steering] proposal insert returned no row");
      return toProposal(row);
    });
  },

  async findProposal(scope, publicId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.steeringProposals)
        .where(
          and(scoped(scope), eq(schema.steeringProposals.publicId, publicId)),
        )
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async findProposalById(id) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.steeringProposals)
        .where(eq(schema.steeringProposals.id, id))
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async mergedRefs(row) {
    if (!row.promotionEventId || !row.publishedRecordId) return null;
    return withTenantDb(async (tx) => {
      const [promotion] = await tx
        .select({ publicId: schema.steeringPromotions.publicId })
        .from(schema.steeringPromotions)
        .where(eq(schema.steeringPromotions.id, row.promotionEventId!))
        .limit(1);
      const [record] = await tx
        .select({ publicId: schema.steeringRecords.publicId })
        .from(schema.steeringRecords)
        .where(eq(schema.steeringRecords.id, row.publishedRecordId!))
        .limit(1);
      if (!promotion || !record) return null;
      return {
        promotionEventPublicId: promotion.publicId,
        recordPublicId: record.publicId,
      };
    });
  },

  async userNames(scope, userIds) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = await withTenantDb((tx) =>
      tx
        .select({ id: schema.users.id, name: schema.users.displayName })
        .from(schema.users)
        .innerJoin(
          schema.orgUsers,
          and(
            eq(schema.orgUsers.userId, schema.users.id),
            eq(schema.orgUsers.orgId, scope.orgId),
          ),
        )
        .where(inArray(schema.users.id, ids)),
    );
    return new Map(
      rows.flatMap((r) =>
        r.name !== null && r.name.trim() !== "" ? [[r.id, r.name]] : [],
      ),
    );
  },

  async findOpenPrOnLineage(scope, lineageId, excludingId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.steeringProposals)
        .where(
          and(
            scoped(scope),
            eq(schema.steeringProposals.lineageId, lineageId),
            sql`${schema.steeringProposals.status} IN (${sql.join(
              OPEN_PR_STATUSES.map((s) => sql`${s}`),
              sql`, `,
            )})`,
            sql`${schema.steeringProposals.id} <> ${excludingId}`,
          ),
        )
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async listProposals(scope, filter, page) {
    const where = and(
      scoped(scope),
      filter.status
        ? eq(schema.steeringProposals.status, filter.status)
        : undefined,
      filter.statuses
        ? inArray(schema.steeringProposals.status, [...filter.statuses])
        : undefined,
      filter.lineageId
        ? eq(schema.steeringProposals.lineageId, filter.lineageId)
        : undefined,
    );
    return withTenantDb(async (tx) => {
      const [c] = await tx
        .select({ total: count() })
        .from(schema.steeringProposals)
        .where(where);
      const rows = await tx
        .select()
        .from(schema.steeringProposals)
        .where(where)
        .orderBy(
          desc(schema.steeringProposals.createdAt),
          desc(schema.steeringProposals.id),
        )
        .limit(page.limit)
        .offset(page.offset);
      return { rows: rows.map(toProposal), total: c?.total ?? 0 };
    });
  },

  async updateProposal(id, patch, from, guard) {
    return withTenantDb(async (tx) => {
      const claimCol = schema.steeringProposals.mergeClaimedAt;
      const [row] = await tx
        .update(schema.steeringProposals)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.steeringProposals.id, id),
            inArray(schema.steeringProposals.status, [...from]),
            guard?.headSha !== undefined
              ? eq(schema.steeringProposals.headSha, guard.headSha)
              : undefined,
            guard?.noClaimSince !== undefined
              ? or(isNull(claimCol), lte(claimCol, guard.noClaimSince))
              : undefined,
            guard?.claimedAt !== undefined
              ? eq(claimCol, guard.claimedAt)
              : undefined,
          ),
        )
        .returning();
      if (row) return toProposal(row);
      const [current] = await tx
        .select({
          publicId: schema.steeringProposals.publicId,
          status: schema.steeringProposals.status,
          headSha: schema.steeringProposals.headSha,
          mergeClaimedAt: claimCol,
        })
        .from(schema.steeringProposals)
        .where(eq(schema.steeringProposals.id, id))
        .limit(1);
      if (!current)
        throw new Error(
          `[context.steering] proposal ${id} vanished during update`,
        );
      throw refusedWrite(current, from, guard);
    });
  },

  async replaceProposal(prior, values) {
    return withTenantDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${values.workspaceId}:${values.lineageId.toLowerCase()}`}, 0))`,
      );
      const claimCol = schema.steeringProposals.mergeClaimedAt;
      const [set] = await tx
        .update(schema.steeringProposals)
        .set({ ...prior.patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.steeringProposals.id, prior.id),
            inArray(schema.steeringProposals.status, [...prior.from]),
            prior.guard?.headSha !== undefined
              ? eq(schema.steeringProposals.headSha, prior.guard.headSha)
              : undefined,
            prior.guard?.noClaimSince !== undefined
              ? or(isNull(claimCol), lte(claimCol, prior.guard.noClaimSince))
              : undefined,
          ),
        )
        .returning({ id: schema.steeringProposals.id });
      if (!set) {
        const [current] = await tx
          .select({
            publicId: schema.steeringProposals.publicId,
            status: schema.steeringProposals.status,
            headSha: schema.steeringProposals.headSha,
            mergeClaimedAt: claimCol,
          })
          .from(schema.steeringProposals)
          .where(eq(schema.steeringProposals.id, prior.id))
          .limit(1);
        if (!current)
          throw new Error(
            `[context.steering] proposal ${prior.id} vanished during replace`,
          );
        throw refusedWrite(current, prior.from, prior.guard);
      }
      const [row] = await tx
        .insert(schema.steeringProposals)
        .values(values)
        .returning();
      if (!row)
        throw new Error("[context.steering] proposal insert returned no row");
      return toProposal(row);
    });
  },

  async listRecords(scope, filter, page) {
    const where = and(
      eq(schema.steeringRecords.orgId, scope.orgId),
      eq(schema.steeringRecords.workspaceId, scope.workspaceId),
      isNull(schema.steeringRecords.deletedAt),
      filter.kind ? eq(schema.steeringRecords.kind, filter.kind) : undefined,
      filter.sharingScope
        ? eq(schema.steeringRecords.sharingScope, filter.sharingScope)
        : undefined,
      filter.status
        ? eq(schema.steeringRecords.status, filter.status)
        : undefined,
      filter.lineageId
        ? eq(schema.steeringRecords.slug, filter.lineageId)
        : undefined,
    );
    return withTenantDb(async (tx) => {
      const [c] = await tx
        .select({ total: count() })
        .from(schema.steeringRecords)
        .where(where);
      const rows = await tx
        .select(recordColumns)
        .from(schema.steeringRecords)
        .leftJoin(
          schema.steeringRecordVersions,
          eq(
            schema.steeringRecordVersions.id,
            schema.steeringRecords.activeVersionId,
          ),
        )
        .where(where)
        .orderBy(
          desc(schema.steeringRecords.updatedAt),
          asc(schema.steeringRecords.slug),
        )
        .limit(page.limit)
        .offset(page.offset);
      return { rows, total: c?.total ?? 0 };
    });
  },

  async findRecord(scope, idOrLineage) {
    return withTenantDb(async (tx) => {
      const [record] = await tx
        .select(recordColumns)
        .from(schema.steeringRecords)
        .leftJoin(
          schema.steeringRecordVersions,
          eq(
            schema.steeringRecordVersions.id,
            schema.steeringRecords.activeVersionId,
          ),
        )
        .where(
          and(
            eq(schema.steeringRecords.orgId, scope.orgId),
            eq(schema.steeringRecords.workspaceId, scope.workspaceId),
            isNull(schema.steeringRecords.deletedAt),
            or(
              eq(schema.steeringRecords.publicId, idOrLineage),
              eq(schema.steeringRecords.slug, idOrLineage),
            ),
          ),
        )
        .limit(1);
      if (!record) return null;
      const versions = await tx
        .select({
          publicId: schema.steeringRecordVersions.publicId,
          version: schema.steeringRecordVersions.versionNumber,
          checksum: schema.steeringRecordVersions.checksum,
          isLatest: schema.steeringRecordVersions.isLatest,
          publishedAt: schema.steeringRecordVersions.publishedAt,
        })
        .from(schema.steeringRecordVersions)
        .where(eq(schema.steeringRecordVersions.recordId, record.id))
        .orderBy(desc(schema.steeringRecordVersions.versionNumber));
      const [publisher] = await tx
        .select({
          publicId: schema.steeringProposals.publicId,
          prUrl: schema.steeringProposals.prUrl,
        })
        .from(schema.steeringProposals)
        .where(
          and(
            eq(schema.steeringProposals.publishedRecordId, record.id),
            eq(schema.steeringProposals.status, "merged"),
          ),
        )
        .orderBy(desc(schema.steeringProposals.mergedAt))
        .limit(1);
      return {
        record,
        versions,
        publishedBy: publisher
          ? { proposalPublicId: publisher.publicId, prUrl: publisher.prUrl }
          : null,
      };
    });
  },

  async recordEffect(scope, lineageId) {
    return withTenantDb(async (tx) => {
      // One statement, two questions, so they cannot disagree: does this
      // workspace record context use at all, and what did this lineage do.
      // Asked as two round trips, a run appending between them could report
      // "no rollup" for a workspace that has one.
      //
      // The run comes out of `source_refs`, where §9 spells a frame ref
      // `frame:<run>/<seq>`. Refs that are not frame refs — a record id, an
      // evidence digest — match nothing and drop out, which is why the run is
      // extracted rather than the array counted.
      const result = await tx.execute(sql`
        select
          count(*) filter (
            where ${schema.contextAppends.kind} in ('context_use', 'context_use_feedback')
          ) as scope_total,
          count(distinct ref.run) filter (
            where ${schema.contextAppends.kind} = 'context_use'
              and ${schema.contextAppends.lineageId} = ${lineageId}
          ) as rendered,
          count(distinct ref.run) filter (
            where ${schema.contextAppends.kind} = 'context_use_feedback'
              and ${schema.contextAppends.lineageId} = ${lineageId}
          ) as cited
        from ${schema.contextAppends}
        left join lateral (
          select substring(source_ref from 'frame:([^/]+)/') as run
          from unnest(${schema.contextAppends.sourceRefs}) as source_ref
        ) as ref on true
        where ${schema.contextAppends.orgId} = ${scope.orgId}
          and ${schema.contextAppends.workspaceId} = ${scope.workspaceId}
      `);
      const [row] = [...result] as {
        scope_total: string | number;
        rendered: string | number;
        cited: string | number;
      }[];
      if (!row || Number(row.scope_total) === 0) return null;
      return { rendered: Number(row.rendered), cited: Number(row.cited) };
    });
  },

  async listActiveRecords(scope) {
    return withTenantDb((tx) =>
      tx
        .select(recordColumns)
        .from(schema.steeringRecords)
        .leftJoin(
          schema.steeringRecordVersions,
          eq(
            schema.steeringRecordVersions.id,
            schema.steeringRecords.activeVersionId,
          ),
        )
        .where(
          and(
            eq(schema.steeringRecords.orgId, scope.orgId),
            eq(schema.steeringRecords.workspaceId, scope.workspaceId),
            eq(schema.steeringRecords.status, "active"),
            isNull(schema.steeringRecords.deletedAt),
          ),
        ),
    );
  },

  async latestPublication(scope) {
    const published = and(
      eq(schema.steeringRecords.orgId, scope.orgId),
      eq(schema.steeringRecords.workspaceId, scope.workspaceId),
      isNotNull(schema.steeringRecords.commitSha),
      isNotNull(schema.steeringRecords.publishedAt),
      isNull(schema.steeringRecords.deletedAt),
    );
    const rows = await withTenantDb((tx) => {
      const newestInstant = tx
        .select({ at: max(schema.steeringRecords.publishedAt) })
        .from(schema.steeringRecords)
        .where(published);
      return (
        tx
          .select({
            commitSha: schema.steeringRecords.commitSha,
            publishedAt: schema.steeringRecords.publishedAt,
          })
          .from(schema.steeringRecords)
          // Every publication at the newest instant, in one round trip.
          // `published_at` is GitHub's merge instant (see `merge_steering_pr`),
          // so a publication retried after a later merge still sorts earlier.
          //
          // GitHub reports that instant to the second, and two PRs can merge
          // inside one. An earlier version broke the tie on `id`, reading it
          // as insert order. It is not publication order: a retried earlier
          // merge inserts last, and a new version of an existing lineage
          // keeps that lineage's old row and its old id. Either way the
          // earlier commit could win, and a checkout at that commit read as
          // current while it lacked the later record. Nothing stored here
          // orders two commits on the branch, so the tie is returned whole.
          .where(
            and(
              published,
              eq(schema.steeringRecords.publishedAt, sql`(${newestInstant})`),
            ),
          )
          // Stable, so `commitSha` does not flip between two reads.
          .orderBy(desc(schema.steeringRecords.id))
      );
    });
    const newest = rows[0];
    if (!newest?.commitSha || !newest.publishedAt) return null;
    const commitShas = [
      ...new Set(
        rows.flatMap((row) => (row.commitSha === null ? [] : [row.commitSha])),
      ),
    ];
    return {
      commitSha: newest.commitSha,
      commitShas,
      publishedAt: newest.publishedAt,
    };
  },

  async ledgerLength(scope) {
    const [c] = await withTenantDb((tx) =>
      tx
        .select({ total: count() })
        .from(schema.steeringPromotions)
        .where(
          and(
            eq(schema.steeringPromotions.orgId, scope.orgId),
            eq(schema.steeringPromotions.workspaceId, scope.workspaceId),
          ),
        ),
    );
    return c?.total ?? 0;
  },

  async versionAndPublication(scope) {
    const published = and(
      eq(schema.steeringRecords.orgId, scope.orgId),
      eq(schema.steeringRecords.workspaceId, scope.workspaceId),
      isNotNull(schema.steeringRecords.commitSha),
      isNotNull(schema.steeringRecords.publishedAt),
      isNull(schema.steeringRecords.deletedAt),
    );
    const { countRow, rows } = await withTenantDb(async (tx) => {
      const newestInstant = tx
        .select({ at: max(schema.steeringRecords.publishedAt) })
        .from(schema.steeringRecords)
        .where(published);
      const [countRow] = await tx
        .select({ total: count() })
        .from(schema.steeringPromotions)
        .where(
          and(
            eq(schema.steeringPromotions.orgId, scope.orgId),
            eq(schema.steeringPromotions.workspaceId, scope.workspaceId),
          ),
        );
      const rows = await tx
        .select({
          commitSha: schema.steeringRecords.commitSha,
          publishedAt: schema.steeringRecords.publishedAt,
        })
        .from(schema.steeringRecords)
        // Same tie-break as `latestPublication`: every publication at the
        // newest instant, stable on id so `commitSha` does not flip between
        // reads.
        .where(
          and(
            published,
            eq(schema.steeringRecords.publishedAt, sql`(${newestInstant})`),
          ),
        )
        .orderBy(desc(schema.steeringRecords.id));
      return { countRow, rows };
    });
    const newest = rows[0];
    const publication =
      newest?.commitSha && newest.publishedAt
        ? {
            commitSha: newest.commitSha,
            commitShas: [
              ...new Set(
                rows.flatMap((row) =>
                  row.commitSha === null ? [] : [row.commitSha],
                ),
              ),
            ],
            publishedAt: newest.publishedAt,
          }
        : null;
    return { version: countRow?.total ?? 0, publication };
  },

  async insertAppend(values) {
    const existing = () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.contextAppends)
          .where(
            and(
              eq(schema.contextAppends.workspaceId, values.workspaceId),
              eq(schema.contextAppends.recordHash, values.recordHash),
            ),
          )
          .limit(1),
      );
    try {
      const [row] = await withTenantDb((tx) =>
        tx.insert(schema.contextAppends).values(values).returning(),
      );
      if (!row)
        throw new Error("[context.steering] append insert returned no row");
      return { row, appended: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [row] = await existing();
      if (!row) throw err;
      return { row, appended: false };
    }
  },

  async findAppendByHash(scope, recordHash) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextAppends)
        .where(
          and(
            eq(schema.contextAppends.orgId, scope.orgId),
            eq(schema.contextAppends.workspaceId, scope.workspaceId),
            eq(schema.contextAppends.recordHash, recordHash),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },

  async findAppend(scope, publicId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextAppends)
        .where(
          and(
            eq(schema.contextAppends.orgId, scope.orgId),
            eq(schema.contextAppends.workspaceId, scope.workspaceId),
            eq(schema.contextAppends.publicId, publicId),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },

  async publishMerge(input) {
    const { scope, proposal } = input;
    return withTenantDb(async (tx) => {
      // The repository sync publishes the same merge when its push arrives
      // (ADR-184). One lock per workspace orders the two, and whichever runs
      // second finds the content already published.
      await lockWorkspacePublication(tx, scope.workspaceId);
      // Take the lock the INSERT below will take anyway, BEFORE probing.
      //
      // `information_schema` is an ordinary catalog read and locks nothing, so
      // without this the migration's `ALTER TABLE` -- which holds ACCESS
      // EXCLUSIVE -- can commit, and its one-time backfill run, in the window
      // between a `false` answer here and the insert. The insert would then
      // succeed against a migrated table while omitting the four columns from
      // its statement, writing a version that is unclassified for good and that
      // the backfill has already passed by (discussion_r4050518857).
      //
      // ROW EXCLUSIVE is exactly what an INSERT acquires, and it does not
      // conflict with itself, so concurrent merges are unaffected; it conflicts
      // only with the DDL, which is the one thing that must not interleave
      // here. Taking it early moves the acquisition, it does not add one.
      await tx.execute(
        sql`lock table ${schema.steeringRecordVersions} in row exclusive mode`,
      );

      // `hasColumnFresh`, not `hasColumn`: a cached MISS must not reach a
      // write. The read path can spend the negative TTL compiling from the
      // record row and be right again on the next call, but a merge that omits
      // the four writes a version that carries NULL for good -- the migration's
      // one-time backfill has already run, and nothing afterwards fills it in.
      // A later merge would then update the record row, and promoting the
      // unclassified version would fall back to that newer row: #3312 again,
      // permanently, for that version (discussion_r4050451667).
      const versionClassificationReady = await hasColumnFresh(
        tx,
        STEERING_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const [existing] = await tx
        .select({
          id: schema.steeringRecords.id,
          publicId: schema.steeringRecords.publicId,
          label: schema.steeringRecords.label,
          activeVersionId: schema.steeringRecords.activeVersionId,
        })
        .from(schema.steeringRecords)
        .where(
          and(
            eq(schema.steeringRecords.orgId, scope.orgId),
            eq(schema.steeringRecords.workspaceId, scope.workspaceId),
            eq(schema.steeringRecords.slug, proposal.lineageId),
            isNull(schema.steeringRecords.deletedAt),
          ),
        )
        .limit(1);

      const classification = {
        title: proposal.title?.trim() || proposal.statement,
        // The merged file names the record (ADR-178). A file written before
        // ADR-178 has no label, and then an omitted label keeps the record's
        // own. The fallback is derived from the slug and fits the 36-character
        // CHECK: a label that fails steering_records_label_check fails after
        // GitHub has merged.
        label:
          readRecordFile(input.body)?.label ??
          proposal.label ??
          existing?.label ??
          steeringRecordLabel(proposal.lineageId),
        status: "active" as const,
        kind: proposal.kind,
        force: proposal.force,
        constraintEffect: proposal.constraintEffect,
        sharingScope: proposal.sharingScope,
        statement: proposal.statement,
        commitSha: input.commitSha,
        path: input.path,
        publishedAt: input.mergedAt,
        activatedByUserId: input.mergedByUserId ?? undefined,
        activatedAt: input.mergedAt,
        updatedById: input.mergedByUserId ?? undefined,
        updatedAt: input.mergedAt,
      };

      let recordId: string;
      let recordPublicId: string;
      if (existing) {
        recordId = existing.id;
        recordPublicId = existing.publicId;
      } else {
        const [created] = await tx
          .insert(schema.steeringRecords)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            slug: proposal.lineageId,
            createdById: input.mergedByUserId ?? undefined,
            ...classification,
          })
          .returning({
            id: schema.steeringRecords.id,
            publicId: schema.steeringRecords.publicId,
          });
        if (!created)
          throw new Error("[context.steering] record insert returned no row");
        recordId = created.id;
        recordPublicId = created.publicId;
      }

      // The repository sync can publish this same merge first, when its push
      // reaches the lock before this call does (ADR-184). The bytes are then
      // already the version in force, and this publication adds the
      // reviewer's promotion to it rather than a second copy of them.
      let reused: { id: string; version: number } | null = null;
      if (existing?.activeVersionId) {
        const [active] = await tx
          .select({
            id: schema.steeringRecordVersions.id,
            versionNumber: schema.steeringRecordVersions.versionNumber,
            checksum: schema.steeringRecordVersions.checksum,
          })
          .from(schema.steeringRecordVersions)
          .where(eq(schema.steeringRecordVersions.id, existing.activeVersionId))
          .limit(1);
        if (active?.checksum === input.checksum)
          reused = { id: active.id, version: active.versionNumber };
      }

      // The version carries what its body says. A later promote of this
      // version copies these four back onto the record row (#3312).
      const version =
        reused ??
        (await appendVersion(tx, {
          scope,
          recordId,
          body: input.body,
          checksum: input.checksum,
          publishedAt: input.mergedAt,
          classification: {
            kind: proposal.kind,
            force: proposal.force,
            constraintEffect: proposal.constraintEffect,
            statement: proposal.statement,
          },
          classificationReady: versionClassificationReady,
          provenance: [
            {
              type: "commit",
              uri: `${proposal.repository ?? ""}@${input.commitSha}:${input.path}`,
              digest: input.checksum,
              method: "steering_pr",
              by: proposal.publicId,
            },
          ],
          byUserId: input.mergedByUserId,
        }));

      await tx
        .update(schema.steeringRecords)
        .set({ ...classification, activeVersionId: version.id })
        .where(eq(schema.steeringRecords.id, recordId));

      // The promotion event: the next link in the record's chain, and one more
      // entry in the workspace ledger (its steering version).
      const promotion = await appendPromotion(tx, {
        scope,
        recordId,
        versionId: version.id,
        action: "promote",
        approverUserId: input.mergedByUserId,
        policyVersion: input.policyVersion,
      });

      // The transition is the transaction's guard: two calls that both read
      // `checks_passed` and both reached here publish once, the second one
      // rolling back its record, version and ledger row.
      const [transitioned] = await tx
        .update(schema.steeringProposals)
        .set({
          status: "merged",
          mergedCommit: input.commitSha,
          mergedAt: input.mergedAt,
          mergedByUserId: input.mergedByUserId,
          publishedRecordId: recordId,
          promotionEventId: promotion.id,
          mergeClaimedAt: null,
          updatedById: input.mergedByUserId ?? undefined,
          updatedAt: input.mergedAt,
        })
        .where(
          and(
            eq(schema.steeringProposals.id, proposal.id),
            eq(schema.steeringProposals.status, "checks_passed"),
          ),
        )
        .returning({ id: schema.steeringProposals.id });
      if (!transitioned) throw alreadyMerged(proposal.publicId);

      return {
        recordId,
        recordPublicId,
        versionId: version.id,
        version: version.version,
        promotion: {
          id: promotion.id,
          publicId: promotion.publicId,
          seq: promotion.seq,
          chainDigest: promotion.chainDigest,
        },
        ledgerBefore: promotion.ledgerBefore,
      };
    });
  },

  async mergeGovernance(input) {
    const [row] = await withTenantDb((tx) =>
      tx
        .update(schema.steeringProposals)
        .set({
          status: "merged",
          mergedCommit: input.commitSha,
          mergedAt: input.mergedAt,
          mergedByUserId: input.mergedByUserId,
          mergeClaimedAt: null,
          updatedById: input.mergedByUserId,
          updatedAt: input.mergedAt,
        })
        .where(
          and(
            eq(schema.steeringProposals.id, input.proposal.id),
            eq(schema.steeringProposals.kind, "governance"),
            eq(schema.steeringProposals.status, "checks_passed"),
          ),
        )
        .returning(),
    );
    if (!row) throw alreadyMerged(input.proposal.publicId);
    return toProposal(row);
  },

  async mergeSteeringPr(input) {
    const { scope, proposal } = input;
    return withTenantDb(async (tx) => {
      // The repository sync and merge_steering_pr's record publication take
      // the same lock, so a retirement never interleaves with either.
      await lockWorkspacePublication(tx, scope.workspaceId);
      const retired: string[] = [];
      for (const lineageId of input.retire) {
        const [record] = await tx
          .select({ id: schema.steeringRecords.id })
          .from(schema.steeringRecords)
          .where(
            and(
              eq(schema.steeringRecords.orgId, scope.orgId),
              eq(schema.steeringRecords.workspaceId, scope.workspaceId),
              eq(schema.steeringRecords.slug, lineageId),
              eq(schema.steeringRecords.status, "active"),
              isNull(schema.steeringRecords.deletedAt),
            ),
          )
          .limit(1);
        if (!record) continue;
        // A retirement is a publication too, as the repository sync writes
        // it: a checkout that still holds the file is behind this commit.
        await tx
          .update(schema.steeringRecords)
          .set({
            status: "retired",
            commitSha: input.commitSha,
            publishedAt: input.mergedAt,
            updatedById: input.mergedByUserId,
            updatedAt: input.mergedAt,
          })
          .where(eq(schema.steeringRecords.id, record.id));
        await appendPromotion(tx, {
          scope,
          recordId: record.id,
          versionId: null,
          action: "retire",
          approverUserId: input.mergedByUserId,
          policyVersion: input.policyVersion,
        });
        retired.push(lineageId);
      }
      // The transition guards the transaction: a second call that also read
      // `checks_passed` rolls back its retirements here.
      const [row] = await tx
        .update(schema.steeringProposals)
        .set({
          status: "merged",
          mergedCommit: input.commitSha,
          mergedAt: input.mergedAt,
          mergedByUserId: input.mergedByUserId,
          mergeClaimedAt: null,
          updatedById: input.mergedByUserId,
          updatedAt: input.mergedAt,
        })
        .where(
          and(
            eq(schema.steeringProposals.id, proposal.id),
            eq(schema.steeringProposals.kind, proposal.kind),
            eq(schema.steeringProposals.status, "checks_passed"),
          ),
        )
        .returning();
      if (!row) throw alreadyMerged(proposal.publicId);
      return { proposal: toProposal(row), retired };
    });
  },

  async recordApproval(input) {
    await withTenantDb((tx) =>
      tx
        .insert(schema.steeringPrApprovals)
        .values({
          orgId: input.scope.orgId,
          workspaceId: input.scope.workspaceId,
          proposalId: input.proposalId,
          userId: input.userId,
          commitSha: input.commitSha,
        })
        .onConflictDoNothing({
          target: [
            schema.steeringPrApprovals.proposalId,
            schema.steeringPrApprovals.userId,
            schema.steeringPrApprovals.commitSha,
          ],
        }),
    );
  },

  async listApprovals(scope, proposalId) {
    const t = schema.steeringPrApprovals;
    return withTenantDb((tx) =>
      tx
        .select({ userId: t.userId, commitSha: t.commitSha })
        .from(t)
        .where(
          and(
            eq(t.orgId, scope.orgId),
            eq(t.workspaceId, scope.workspaceId),
            eq(t.proposalId, proposalId),
          ),
        )
        .orderBy(asc(t.createdAt), asc(t.id)),
    );
  },
};
