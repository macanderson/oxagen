// steering-repo/pr-proposal.ts: the proposal row every steering PR Oxagen
// opens carries (#5122, ADR-265).
//
// merge_context_pr lands a steering PR only from a proposal row. A record PR
// and a governance PR always had one. The revert, tools, Markdown import,
// memory, and agent PRs now get one too, written here by their opener once
// the PR is open. The row's kind names the PR, its lineage is the PR's branch
// (a record revert passes the record's lineage instead), and its path is the
// folder every changed file sits under. It carries no record checks: the
// merge runs the steering checks on the PR's head itself.
//
// The opener calls recordSteeringPrQuietly after the host opened the PR, and again
// after each commit it adds to that PR. A second call for the same PR moves
// the row to the new head. An open row on the same lineage for another PR is
// set aside, because the host allows one open PR per branch, so that PR was
// closed and the repository sync has not read the close yet.
import {
  resolveActingUserId,
  type ActingCredential,
} from "@oxagen/iam/org-role";
import type {
  GovernanceMode,
  ProposalStatus,
  SteeringPrKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type { SteeringRepository } from "../context.steering.github";
import {
  claimCutoff,
  type ProposalRow,
  type SteeringStore,
} from "../context.steering.store";
import { logger } from "../logger";

/** The store calls the writer makes. */
export type SteeringPrProposalStore = Pick<
  SteeringStore,
  "findOpenPrOnLineage" | "insertProposal" | "replaceProposal" | "updateProposal"
>;

/** Who opened the PR. */
export interface SteeringPrAuthor {
  /** The signed-in person, or null for a job such as the server sync or the curator. */
  userId: string | null;
  /** What the row records as its source: `user:<uuid>`, or the job's name. */
  source: string;
}

/** The author of a PR a signed-in person opened. */
export function personAuthor(userId: string): SteeringPrAuthor {
  return { userId, source: `user:${userId}` };
}

/** The author of a PR a job opened with no person behind it. */
export function jobAuthor(job: string): SteeringPrAuthor {
  return { userId: null, source: job };
}

/**
 * The author of a PR a capability call opened. The person is the acting user
 * the role check passed: the signed-in person, or the creator of the API key
 * the call carried (resolveActingUserId). The row keeps that person as its
 * author, so in team and regulated mode they cannot merge their own change by
 * scripting it with a key. The source still names the key.
 */
export function authorOf(
  ctx: Pick<ActingCredential, "userId" | "apiKeyId">,
  actingUserId: string | null,
): SteeringPrAuthor {
  if (ctx.userId) return personAuthor(ctx.userId);
  if (ctx.apiKeyId) {
    return { userId: actingUserId, source: `api_key:${ctx.apiKeyId}` };
  }
  return actingUserId === null ? jobAuthor("oxagen") : personAuthor(actingUserId);
}

/** authorOf, for a caller that has not resolved the acting user. */
export async function actingAuthor(
  ctx: ActingCredential,
): Promise<SteeringPrAuthor> {
  return authorOf(ctx, await resolveActingUserId(ctx));
}

export interface SteeringPrRecord {
  scope: { orgId: string; workspaceId: string };
  repo: SteeringRepository;
  kind: SteeringPrKind;
  pullRequest: { number: number; url: string; branch: string; headSha: string };
  /** The PR's title. The row keeps it as its statement. */
  title: string;
  /** Every path the PR changes. The row's path is the folder they share. */
  paths: readonly string[];
  /**
   * What the opener's steering check concluded on the head: `success`,
   * `failure`, or null when no check ran or its report did not reach the host.
   */
  check: "success" | "failure" | null;
  author: SteeringPrAuthor;
  /** The governance mode on the production branch when the PR opened, when the opener read it. */
  mode?: GovernanceMode | null;
  /** The row's lineage. The branch, unless a record revert names the record's. */
  lineageId?: string;
  /** The row's path. The shared folder of `paths`, unless the caller names one. */
  path?: string;
  /** What the row's rationale says about the PR, one or two sentences. */
  rationale?: string;
}

/** No proposal has this id, so a lineage lookup excludes nothing. */
const NO_PROPOSAL = "00000000-0000-0000-0000-000000000000";

/** The statuses of a proposal whose PR is open. */
const OPEN_PR: readonly ProposalStatus[] = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
];

/**
 * The deepest folder that holds every path, such as `tools/servers/billing`
 * for one server's files, or `.` when the paths share none.
 */
function sharedFolder(paths: readonly string[]): string {
  const folders = paths.map((path) => path.split("/").slice(0, -1));
  const first = folders[0];
  if (first === undefined) return ".";
  let depth = first.length;
  for (const folder of folders.slice(1)) {
    let same = 0;
    while (same < depth && same < folder.length && folder[same] === first[same]) {
      same += 1;
    }
    depth = same;
  }
  return depth === 0 ? "." : first.slice(0, depth).join("/");
}

/** The status the opener's check conclusion puts the row in. */
function statusOf(check: SteeringPrRecord["check"]): ProposalStatus {
  if (check === "success") return "checks_passed";
  if (check === "failure") return "checks_failed";
  return "pr_open";
}

/**
 * Write or move the proposal row for an open steering PR, and answer it. The
 * caller has opened the PR, or added a commit to it, and reported its check.
 */
async function recordSteeringPr(
  store: SteeringPrProposalStore,
  input: SteeringPrRecord,
  now: Date = new Date(),
): Promise<ProposalRow> {
  const { scope, repo, kind, pullRequest, author } = input;
  const lineageId = input.lineageId ?? pullRequest.branch;
  const status = statusOf(input.check);
  const open = await store.findOpenPrOnLineage(scope, lineageId, NO_PROPOSAL);
  if (
    open !== null &&
    open.kind === kind &&
    open.prNumber === pullRequest.number &&
    (open.provider ?? "github") === repo.provider
  ) {
    // A commit added to the PR this row already names: the row follows it.
    return store.updateProposal(
      open.id,
      {
        status,
        headSha: pullRequest.headSha,
        checks: [],
        updatedById: author.userId,
      },
      OPEN_PR,
      { noClaimSince: claimCutoff(now) },
    );
  }
  const values = {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    lineageId,
    kind,
    // A steering PR publishes no single record, so the record fields carry
    // what a governance proposal's do: no force and the workspace's scope.
    force: "info",
    constraintEffect: null,
    sharingScope: "workspace",
    statement: input.title,
    rationale:
      input.rationale ??
      `Oxagen opened this steering PR on ${pullRequest.branch}. Merge it from Oxagen, so it lands through the merge queue with the stamp and the ledger line.`,
    source: author.source,
    supportRuns: [],
    supportAgents: [],
    supportingRecordIds: [],
    evidenceLinks: [],
    createdById: author.userId,
    status,
    governanceMode: input.mode ?? null,
    provider: repo.provider,
    repository: repo.fullName,
    baseRef: repo.defaultBranch,
    branch: pullRequest.branch,
    path: input.path ?? sharedFolder(input.paths),
    prNumber: pullRequest.number,
    prUrl: pullRequest.url,
    headSha: pullRequest.headSha,
    checks: [],
  } satisfies Parameters<SteeringStore["insertProposal"]>[0];
  if (open === null) return store.insertProposal(values);
  return store.replaceProposal(
    {
      id: open.id,
      patch: {
        status: "rejected",
        dismissedAt: now,
        dismissedReason: `Replaced by #${pullRequest.number} on ${pullRequest.branch}`,
        updatedById: author.userId,
      },
      from: OPEN_PR,
      guard: { noClaimSince: claimCutoff(now) },
    },
    values,
  );
}

/**
 * recordSteeringPr for an opener whose PR is already open on the host. A
 * failure is logged and answered as null rather than thrown: the PR exists,
 * and the caller has a branch and a PR number to keep. The next commit the
 * opener adds to the PR writes the row again.
 */
export async function recordSteeringPrQuietly(
  store: SteeringPrProposalStore,
  input: SteeringPrRecord,
  now: Date = new Date(),
): Promise<ProposalRow | null> {
  try {
    return await recordSteeringPr(store, input, now);
  } catch (err) {
    logger.error(
      {
        err,
        orgId: input.scope.orgId,
        workspaceId: input.scope.workspaceId,
        kind: input.kind,
        pr: input.pullRequest.url,
      },
      "steering PR: the PR is open, but its proposal row was not written, so Oxagen cannot merge it until the opener writes the row again",
    );
    return null;
  }
}
