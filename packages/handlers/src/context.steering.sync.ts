// context.steering.sync.ts: the repository sync (ADR-184). The record files on
// the steering repository's production branch are the records in force; the
// registry mirrors them for listing, the ledger, and the policy bundle every
// wrapped agent receives. Provisioned GitHub repositories verify the captured
// commit before changing live state. Their changes must come through an
// authenticated Oxagen merge or restore the published tree. Legacy repositories
// and GitLab keep their existing host synchronization behavior.
//
// A push or a merge on the host starts it through the webhook, a scheduled
// sweep catches a delivery the webhook missed, and it is idempotent: the
// webhook is a trigger and the host's API is the truth, so a duplicate or
// out-of-order delivery reads the same branch and finds nothing left to do.
//
// Flow:
//   1. The workspace's steering repository. No repository, no sync.
//   2. Every open steering PR, read from the host before the branch, so a merge
//      seen here is already on the head read next.
//   3. The production branch's head and its provenance. A missing or refused
//      verifier on a provisioned GitHub repository stops all live writes.
//   4. Every file under `.oxagen/rules/` at that head, planned against the
//      registry and written in one transaction (context.steering.sync.store).
//   5. workspace.toml at that head. Its settings go to the workspace row, and
//      its `[[repositories]]` list moves the linked heads (ADR-212,
//      repository.link.reconcile): an entry that appears since the last synced
//      head is linked, and one that goes away is unlinked. This runs once per
//      synced head, here and never in step 8. A problem with the file, or a
//      repository the sync cannot link, is a warning.
//   6. The steering PRs: a merged one points at its published record, a closed
//      one is rejected, and one whose head moved has its checks reset. A
//      proposal a merge from Oxagen has claimed is left to that merge. A
//      merged governance or steering PR publishes no single record, so its
//      row reads merged with its merge commit and nothing else (#4795,
//      #5122).
//   7. The sync state, and a check on the head commit naming every problem.
//      Then the governance change, when the head moved: a governance mode in
//      steering/governance.toml that differs from the last synced head's, on
//      a commit Oxagen's records do not hold, landed outside Oxagen. The sync
//      records it as `steering.governance_changed`, and as
//      `steering.governance_overridden` when the mode it replaced asked for
//      review. Every Oxagen merge writes an `Oxagen-Version` trailer, stores
//      that version, and records its own event, so the sync records only the
//      changes nobody else does. A trailer with no record behind it counts as
//      outside, because anyone who can push can write one.
//   8. The workspace's steering repository published as its next steering
//      version (#4447), when a publisher is wired. The publisher resolves the
//      steering head and reads it again under its own lock. A version it
//      publishes is recorded as a deployment to the steering environment. A
//      publish that fails is a warning: the registry already matches the
//      branch, and the next sync tries again.
import { emitSecurityEvent } from "@oxagen/database/security";
import { HandlerError } from "@oxagen/oxagen";
import {
  isRecordKind,
  type GovernanceMode,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  type FileIssue,
  readTomlFile,
} from "@oxagen/oxagen/steering-repo/files";
import {
  governanceSchema,
  resolveGovernance,
} from "@oxagen/oxagen/steering-repo/governance";
import {
  GOVERNANCE_TOML_PATH,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import type { SecurityEventInput } from "@oxagen/telemetry";
import type {
  SteeringHost,
  SteeringRepository,
} from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import {
  claimCutoff,
  mergeClaimed,
  postgresSteeringStore,
  type ProposalRow,
  type SteeringStore,
} from "./context.steering.store";
import {
  planSync,
  RULES_DIR,
  type SyncFinding,
} from "./context.steering.sync.plan";
import {
  postgresSyncStore,
  type PublishedWorkspaceSettings,
  type SyncState,
  type SyncStore,
} from "./context.steering.sync.store";
import {
  checksAfterMove,
  closedOnHostReason,
  hostName,
  OPEN_PR,
  resetsOnMove,
} from "./context.steering.pr-state";
import { logger } from "./logger";
import {
  type ReconcileLinks,
  reconcileWorkspaceLinks,
} from "./repository.link.reconcile";
import {
  listedRepositories,
  readWorkspaceToml,
} from "./repository.workspace-toml";
import { withToolProjection } from "./mcp-studio/publish-deps";
import { assertSteeringCommit } from "./steering-repo/provenance";
import { versionTrailer } from "./steering-repo/diverged";
import { readSteeringHealth } from "./steering-repo/health.read";
import {
  steeringRepositoryKey,
  steeringSyncPublish,
} from "./steering-repo/publisher";
import { postgresVersionStore } from "./steering-repo/version-store";

/** What one publish of the workspace's steering repository did. */
export interface SyncPublished {
  /**
   * `refused` while the steering repository is not healthy, `current` when its
   * head is already published, and `stale` when its branch moved between the
   * publisher's head read and the publish. The next sync publishes the newer
   * head.
   */
  status: "refused" | "current" | "stale" | "published";
  /** The published version's number, or null when the publish was refused or stale. */
  version: number | null;
}

/**
 * Publishes the head of the workspace's steering repository as its next
 * steering version (@oxagen/steering-bundle `publish`). It takes only the
 * sync's scope. The port resolves the steering repository and reads its
 * production head itself, under the publisher's lock. It answers null when
 * the repository is in the legacy layout and has no bundle to publish.
 * `steeringSyncPublish` (./steering-repo/publisher) builds it.
 */
export type SyncPublish = (scope: {
  orgId: string;
  workspaceId: string;
}) => Promise<SyncPublished | null>;

export interface SyncDeps {
  github: SteeringHost;
  store: SyncStore;
  steering: Pick<SteeringStore, "updateProposal">;
  now: () => Date;
  /**
   * The sync publishes nothing when this is unset, as in tests that do not
   * exercise step 8. The production deps build it through
   * `withToolProjection` (./mcp-studio/publish-deps), so each version it
   * publishes also writes the workspace's tool registry.
   */
  publish?: SyncPublish;
  /**
   * Moves the linked heads to match workspace.toml's `[[repositories]]` list
   * (ADR-212). Unset, the sync leaves every head alone.
   */
  reconcileLinks?: ReconcileLinks;
  /**
   * Records a governance change that landed outside Oxagen (#4795). Unset,
   * the sync still finds the change and answers it in the outcome.
   */
  emit?: (event: SecurityEventInput) => void;
  /**
   * The steering version Oxagen stored at a commit of the workspace's
   * steering repository, or null. A merge Oxagen made stores its version, so
   * this backs the commit's `Oxagen-Version` trailer (#4795). Unset, only a
   * governance proposal Oxagen merged backs it.
   */
  steeringVersionAt?: (
    scope: { orgId: string; workspaceId: string },
    repo: SteeringRepository,
    commitSha: string,
  ) => Promise<{ version: number } | null>;
}

export function syncDeps(): SyncDeps {
  const github = createSteeringHost();
  return {
    github,
    store: postgresSyncStore,
    steering: postgresSteeringStore,
    now: () => new Date(),
    reconcileLinks: reconcileWorkspaceLinks,
    emit: emitSecurityEvent,
    steeringVersionAt: (scope, repo, commitSha) =>
      postgresVersionStore(scope).versionAt(steeringRepositoryKey(repo), commitSha),
    // The same publisher merge_steering_pr calls, over the same host, so a
    // verified GitHub merge reaches the same version sequence.
    // The publish refuses while the steering repo is not healthy (S2).
    // Each version the sync publishes is recorded as a deployment, as a
    // merge's is. That covers a merge whose own publish failed (#4449).
    publish: steeringSyncPublish({
      host: github,
      extend: withToolProjection,
      readHealth: readSteeringHealth,
      recordDeployments: true,
    }),
  };
}

export interface SyncOutcome {
  outcome: "no_repository" | "current" | "synced" | "problems";
  headSha: string | null;
  created: number;
  revised: number;
  updated: number;
  retired: number;
  proposals: { merged: number; rejected: number; stale: number };
  findings: SyncFinding[];
  /**
   * Seconds to wait before syncing again, or null. Set while a steering PR
   * Oxagen merged is still inside its grace window: `merge_steering_pr`
   * publishes it with its reviewer on the ledger, and the sync leaves it alone
   * until the window passes.
   */
  retryAfterSeconds: number | null;
  /** What publishing the steering repository did, or null when nothing published it. */
  published?: SyncPublished | null;
  /**
   * The governance change this sync found on the production branch with no
   * Oxagen merge behind it, or null.
   */
  governanceChange: GovernanceChange | null;
}

/** A governance mode that changed on the production branch outside Oxagen. */
interface GovernanceChange {
  previousMode: GovernanceMode;
  mode: GovernanceMode;
  /** The commit that last changed steering/governance.toml. */
  commitSha: string;
  /** The governance proposal whose PR merged as that commit, or null for a push. */
  proposalId: string | null;
  pullRequest: string | null;
}

/** How long a merge Oxagen made is left to `merge_steering_pr` to publish. */
export const MERGE_GRACE_SECONDS = 90;

/** The most record files one sync reads. Past it the sync refuses rather than cut. */
export const SYNC_MAX_FILES = 500;

/** How many file reads one sync keeps in flight. */
const READ_CONCURRENCY = 8;

/** The check the sync posts on the production branch's head. */
export const SYNC_CHECK_NAME = "Oxagen steering sync";

type PullState = Awaited<ReturnType<SteeringHost["getPullRequest"]>>;

async function readAll(
  github: SteeringHost,
  repo: SteeringRepository,
  ref: string,
  paths: string[],
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY);
    const texts = await Promise.all(
      batch.map((path) => github.readFile(repo, path, ref)),
    );
    batch.forEach((path, j) => {
      const text = texts[j];
      // The tree listed this path at this commit, so an empty read is a read
      // that failed. Planning without the file would retire its record, so
      // the whole sync stops and runs again.
      if (text === null || text === undefined)
        throw new Error(
          `[context.sync] could not read ${path} at ${ref}; the sync will run again`,
        );
      out.push({ path, text });
    });
  }
  return out;
}

/** A finding list as a check summary: one line per problem. */
function checkSummary(findings: SyncFinding[]): string {
  if (findings.length === 0)
    return "Every record file under `.oxagen/rules/` is in the registry.";
  return findings
    .map(
      (f) =>
        `- ${f.level === "error" ? "Not published" : "Warning"}: ${f.message}`,
    )
    .join("\n");
}

/** The most findings one sync keeps; past it, one more finding says how many were cut. */
const MAX_FINDINGS = 50;

/**
 * The findings a sync stores. They ride every freshness read and every check
 * summary (GitHub caps a summary at 65,535 characters), so a tree with
 * thousands of broken files keeps the first fifty and a count.
 */
function capFindings(findings: SyncFinding[]): SyncFinding[] {
  if (findings.length <= MAX_FINDINGS) return findings;
  const cut = findings.length - MAX_FINDINGS + 1;
  return [
    ...findings.slice(0, MAX_FINDINGS - 1),
    {
      level: findings.some((f) => f.level === "error") ? "error" : "warning",
      path: RULES_DIR,
      lineageId: null,
      code: "schema",
      message: `${cut} more steering file problems are not listed. Fix the ones above and the next sync lists the rest.`,
    },
  ];
}

function sameFindings(a: SyncFinding[], b: SyncFinding[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What one read of workspace.toml gives the sync. */
interface SettingsRead {
  /** The settings to write, or null to keep the ones the workspace has. */
  publish: PublishedWorkspaceSettings | null;
  findings: SyncFinding[];
  /** The repositories the file lists, or null when nobody can tell. */
  repositories: string[] | null;
}

/**
 * The settings and the linked repositories workspace.toml sets at `ref`
 * (workspace/v1), read the way `link_repository` reads it
 * (repository.workspace-toml). With no such file, the workspace falls back to
 * every default and no linked head moves. A file of that name whose first line
 * does not name workspace/v1 is some other tool's configuration, so it sets
 * nothing and moves no head either.
 *
 * A workspace/v1 file that does not read cleanly leaves the last settings and
 * the linked heads in place, and becomes one warning. It is never an error: a
 * steering repository that was a code repository before may still carry
 * another tool's file there, and the check must not fail over it.
 */
async function readWorkspaceSettings(
  github: SteeringHost,
  repo: SteeringRepository,
  ref: string,
): Promise<SettingsRead> {
  const file = readWorkspaceToml(
    await github.readFile(repo, WORKSPACE_TOML_PATH, ref),
  );
  switch (file.kind) {
    case "missing":
    case "foreign":
      // No workspace/v1 file lists nothing, and a slip on its first line
      // would otherwise unlink every repository it listed. Removal takes a
      // file that still reads and no longer lists the repository.
      return {
        publish: { stellaArchiveAfterDays: null, embeddings: null },
        findings: [],
        repositories: null,
      };
    case "unreadable":
      return {
        publish: null,
        findings: [settingsFinding(file.issues)],
        repositories: null,
      };
    case "read":
      return {
        publish: {
          stellaArchiveAfterDays: file.value.stella?.archive_after_days ?? null,
          embeddings: file.value.embeddings ?? null,
        },
        findings: [],
        repositories: file.repositories,
      };
  }
}

/**
 * The repositories workspace.toml listed at the last synced head, or null
 * when nobody can tell: no head was synced before, it was another repository's
 * head, or the file there did not read. A commit the host no longer has reads
 * as a missing file, which lists nothing, so no head is removed on its word.
 */
async function priorRepositories(
  github: SteeringHost,
  repo: SteeringRepository,
  prior: SyncState | null,
  head: string,
  current: string[],
): Promise<string[] | null> {
  if (prior?.headSha == null) return null;
  if (prior.provider !== repo.provider || prior.repository !== repo.fullName)
    return null;
  if (prior.headSha === head) return current;
  return listedRepositories(
    readWorkspaceToml(
      await github.readFile(repo, WORKSPACE_TOML_PATH, prior.headSha),
    ),
  );
}

/** A workspace.toml that did not read cleanly, as one warning. */
function settingsFinding(issues: FileIssue[]): SyncFinding {
  const first = issues[0] ?? { line: null, field: null, message: "" };
  const at = first.line === null ? "" : ` at line ${first.line}`;
  // Never the parser's own words, for the reason `where` gives in
  // context.steering.sync.plan.ts: smol-toml can quote the lines around the
  // error.
  const parser = first.message.startsWith("the file is not TOML");
  const field = first.field === null ? "" : `, ${first.field}`;
  const reason = first.message.endsWith(".")
    ? first.message
    : `${first.message}.`;
  const problem = parser
    ? `${WORKSPACE_TOML_PATH} is not valid TOML${at}.`
    : `${WORKSPACE_TOML_PATH}${at}${field}: ${reason}`;
  const rest = issues.length - 1;
  const more =
    rest > 0
      ? ` The file has ${rest} more ${rest === 1 ? "problem" : "problems"}.`
      : "";
  return {
    level: "warning",
    path: WORKSPACE_TOML_PATH,
    lineageId: null,
    code: first.field === null ? "not_toml" : "schema",
    message: `${problem}${more} The workspace keeps its last settings.`,
  };
}

/**
 * Make the workspace's registry match its main repository's production
 * branch. `force` reads the branch even when its head has not moved.
 */
export async function syncWorkspaceSteering(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  options: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    outcome: "current",
    headSha: null,
    created: 0,
    revised: 0,
    updated: 0,
    retired: 0,
    proposals: { merged: 0, rejected: 0, stale: 0 },
    findings: [],
    retryAfterSeconds: null,
    governanceChange: null,
  };

  let repo: SteeringRepository;
  try {
    repo = await deps.github.resolveRepository(scope);
  } catch (err) {
    // No steering repository is a workspace with nothing to sync, not a failure.
    // A request the webhook already stamped is answered, though: an
    // unanswered stamp reads as pending for good, and the page would refresh
    // itself forever waiting for it.
    if (err instanceof HandlerError && err.code === "not_found") {
      const prior = await deps.store.readState(scope);
      if (prior)
        await deps.store.writeState(scope, {
          ...prior,
          status: "failed",
          error:
            "This workspace has no steering repository Oxagen can read, so there is nothing to sync.",
          syncedAt: deps.now(),
        });
      return { ...outcome, outcome: "no_repository" };
    }
    await recordFailure(deps, scope, null, err);
    throw err;
  }

  const prior = await deps.store.readState(scope);
  try {
    // 2. The open steering PRs, before the branch.
    const pulls: { row: ProposalRow; pr: PullState }[] = [];
    for (const row of await deps.store.openProposals(scope)) {
      if (row.prNumber === null || (row.provider ?? "github") !== repo.provider)
        continue;
      try {
        pulls.push({
          row,
          pr: await deps.github.getPullRequest(repo, row.prNumber),
        });
      } catch (err) {
        logger.warn(
          { err, proposal: row.publicId, pr: row.prNumber },
          "context.sync: could not read a steering PR; the next sync reads it again",
        );
      }
    }
    const now = deps.now();
    const defer = new Set<string>();
    const merged: { row: ProposalRow; pr: PullState }[] = [];
    for (const p of pulls) {
      if (!p.pr.merged || p.pr.baseRef !== repo.defaultBranch) continue;
      // A merge from Oxagen claims the proposal before it stamps the PR, so
      // the PR's head is the stamp while the row still names the head the
      // checks ran on. The claim alone defers it, whatever the head (#4504).
      const inGrace =
        mergeClaimed(p.row, now) ||
        (p.row.status === "checks_passed" &&
          p.pr.headSha === p.row.headSha &&
          p.pr.mergedAt !== null &&
          now.getTime() - p.pr.mergedAt.getTime() <
            MERGE_GRACE_SECONDS * 1000);
      if (inGrace) defer.add(p.row.lineageId);
      else merged.push(p);
    }

    // 3. The production branch's head.
    const head = await deps.github.branchHead(repo, repo.defaultBranch);
    if (head === null)
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_missing",
        message: `${repo.fullName} has no branch ${repo.defaultBranch}, the production branch its binding approved.`,
      });
    outcome.headSha = head;
    // The trusted binding requires this even if the commit deletes governance.toml.
    await assertSteeringCommit(deps.github, repo, head);

    // 4. The record files at that head, planned and written. A push that
    // left `.oxagen/rules/` alone changes no record: the newest commit that
    // touched it is the one the last sync read, and nothing more is listed.
    let findings = prior?.findings ?? [];
    const failedBefore = prior?.status === "failed";
    const settling = merged.length > 0 || defer.size > 0;
    const headMoved = prior?.headSha !== head;
    const last =
      options.force || failedBefore || settling || headMoved
        ? await deps.github.lastCommitForPath(repo, RULES_DIR, head)
        : null;
    let rulesSha = headMoved ? (last?.sha ?? null) : (prior?.rulesSha ?? null);
    const rulesMoved =
      prior === null || (headMoved && rulesSha !== prior.rulesSha);
    const readTree = options.force || failedBefore || settling || rulesMoved;
    if (readTree) {
      rulesSha = last?.sha ?? null;
      const paths = await deps.github.listFiles(repo, head, RULES_DIR);
      if (paths.length > SYNC_MAX_FILES)
        throw new HandlerError({
          code: "conflict",
          reason: "steering_too_large",
          message: `${RULES_DIR}/ holds ${paths.length} files at ${head.slice(0, 7)}. The sync reads at most ${SYNC_MAX_FILES}.`,
        });
      const files = await readAll(deps.github, repo, head, paths);
      const applied = await deps.store.apply(
        scope,
        {
          commitSha: last?.sha ?? head,
          publishedAt: last ? new Date(last.committedAt) : now,
          repository: repo.fullName,
          authoredBy: last?.authorLogin ?? last?.authorName ?? null,
          now,
        },
        (records) => planSync({ files, records, defer }),
      );
      findings = capFindings(applied.plan.findings);
      Object.assign(outcome, {
        created: applied.created,
        revised: applied.revised,
        updated: applied.updated,
        retired: applied.retired,
      });
    }

    // 5. workspace.toml at that head. Any push can change it, so the file is
    // read whenever the head moves. Otherwise its last findings stand. A read
    // that fails stops the sync, and the next run reads the file again.
    let settingsFindings = (prior?.findings ?? []).filter(
      (f) => f.path === WORKSPACE_TOML_PATH,
    );
    if (options.force || failedBefore || headMoved) {
      const settings = await readWorkspaceSettings(deps.github, repo, head);
      if (settings.publish)
        await deps.store.publishWorkspaceSettings(scope, settings.publish);
      settingsFindings = settings.findings;
      // The linked heads follow the list. With no workspace/v1 file that
      // reads, none moves. The prior list is the last synced head's, and a
      // failed sync keeps that head, so the next run compares the same two
      // lists again.
      if (deps.reconcileLinks && settings.repositories !== null) {
        const reconciled = await deps.reconcileLinks(scope, {
          prior: await priorRepositories(
            deps.github,
            repo,
            prior,
            head,
            settings.repositories,
          ),
          current: settings.repositories,
          now,
        });
        settingsFindings = [...settingsFindings, ...reconciled.findings];
      }
    }
    findings = [
      ...findings.filter((f) => f.path !== WORKSPACE_TOML_PATH),
      ...settingsFindings,
    ];
    outcome.findings = findings;

    // 6. The steering PRs.
    const noClaimSince = claimCutoff(now);
    for (const { row, pr } of pulls) {
      // A merge from Oxagen is landing this PR. It moves the proposal itself,
      // and the next sync reads what it left.
      if (mergeClaimed(row, now)) continue;
      if (pr.merged && pr.baseRef !== repo.defaultBranch) {
        if (
          await reject(
            deps,
            repo,
            row,
            `Merged on ${hostName(repo)} into ${pr.baseRef}, which is not the production branch ${repo.defaultBranch}`,
            now,
            noClaimSince,
          )
        )
          outcome.proposals.rejected += 1;
      } else if (!pr.merged && !pr.open) {
        if (
          await reject(
            deps,
            repo,
            row,
            closedOnHostReason(repo),
            now,
            noClaimSince,
          )
        )
          outcome.proposals.rejected += 1;
      } else if (
        pr.open &&
        pr.headSha !== null &&
        row.headSha !== null &&
        pr.headSha !== row.headSha &&
        resetsOnMove(row)
      ) {
        // The branch moved on the host after the checks ran. The checks no
        // longer describe what would merge, so they go back to pending and
        // the page asks for a new run. Only a record proposal runs the six
        // record checks. A governance or steering PR proposal runs the
        // steering checks: setting the mode again, or the merge, runs them
        // (#4795, #5122).
        try {
          await deps.steering.updateProposal(
            row.id,
            {
              status: "pr_open",
              headSha: pr.headSha,
              checks: checksAfterMove(row.kind),
              // The stored findings described the old head (#4518).
              checkFindings: [],
            },
            [row.status],
            { headSha: row.headSha, noClaimSince },
          );
          outcome.proposals.stale += 1;
        } catch (err) {
          if (!(err instanceof HandlerError && err.code === "conflict"))
            throw err;
        }
      }
    }
    for (const { row, pr } of merged) {
      // A governance or steering PR publishes no single record, so there is
      // none to link. The row reads merged with its commit, and no approver,
      // because nobody approved it in Oxagen (#4795, #5122).
      if (!isRecordKind(row.kind)) {
        const linked = await deps.store.linkMergedWithoutRecord(scope, row.id, {
          mergedCommit: pr.mergeCommitSha ?? head,
          mergedAt: pr.mergedAt ?? now,
          noClaimSince,
        });
        if (linked) {
          outcome.proposals.merged += 1;
          await dropBranch(deps, repo, row);
        }
        continue;
      }
      // A file the sync refused did not publish, so the record still holds
      // its last good version. Linking the proposal to that version would
      // report the merge as published when it was not.
      const refused = findings.find(
        (f) =>
          f.level === "error" &&
          (f.lineageId?.toLowerCase() === row.lineageId.toLowerCase() ||
            (row.path !== null && f.path === row.path)),
      );
      const linked =
        !refused &&
        (await deps.store.linkMergedProposal(scope, row.id, {
          lineageId: row.lineageId,
          mergedCommit: pr.mergeCommitSha ?? head,
          mergedAt: pr.mergedAt ?? now,
          noClaimSince,
        }));
      if (linked) {
        outcome.proposals.merged += 1;
        await dropBranch(deps, repo, row);
        continue;
      }
      const why =
        refused?.message ??
        `no record file on ${repo.defaultBranch} holds ${row.lineageId}`;
      if (
        await reject(
          deps,
          repo,
          row,
          `Merged on ${hostName(repo)}, but Oxagen could not publish it: ${why}`,
          now,
          noClaimSince,
        )
      )
        outcome.proposals.rejected += 1;
    }

    // 7. The state, and the check on the head.
    // One check per change to the rules, not per push: a commit that left
    // `.oxagen/rules/` alone gets no check of its own.
    const changedFindings = !sameFindings(findings, prior?.findings ?? []);
    if ((readTree && rulesMoved) || changedFindings) {
      const errors = findings.filter((f) => f.level === "error").length;
      await deps.github
        .reportCheckRun(repo, {
          name: SYNC_CHECK_NAME,
          headSha: head,
          conclusion: errors > 0 ? "failure" : "success",
          title:
            findings.length === 0
              ? "The registry matches this commit"
              : `${findings.length} steering file ${findings.length === 1 ? "problem" : "problems"}`,
          summary: checkSummary(findings),
          startedAt: now.toISOString(),
          completedAt: deps.now().toISOString(),
        })
        .catch((err: unknown) =>
          logger.warn(
            { err, head },
            "context.sync: could not post the sync check",
          ),
        );
    }
    await deps.store.writeState(scope, {
      provider: repo.provider,
      repository: repo.fullName,
      branch: repo.defaultBranch,
      headSha: head,
      rulesSha,
      status: findings.length > 0 ? "problems" : "synced",
      findings,
      error: null,
      syncedAt: deps.now(),
    });
    outcome.outcome =
      findings.length > 0
        ? "problems"
        : outcome.created +
              outcome.revised +
              outcome.updated +
              outcome.retired >
              0 ||
            outcome.proposals.merged +
              outcome.proposals.rejected +
              outcome.proposals.stale >
              0
          ? "synced"
          : "current";
    outcome.retryAfterSeconds = defer.size > 0 ? MERGE_GRACE_SECONDS : null;
    // The governance change, once the state names this head. A sync that
    // failed before here reads the same two heads again on its next run, so
    // the change is recorded once.
    if (headMoved && prior?.headSha) {
      outcome.governanceChange = await governanceChangeOutside(
        deps,
        scope,
        repo,
        { from: prior.headSha, to: head },
        pulls,
      );
      if (outcome.governanceChange)
        recordGovernanceChange(deps, scope, repo, outcome.governanceChange);
    }
    outcome.published = await publishSteering(deps, scope);
    logger.info(
      {
        workspaceId: scope.workspaceId,
        head,
        outcome: outcome.outcome,
        created: outcome.created,
        revised: outcome.revised,
        updated: outcome.updated,
        retired: outcome.retired,
        proposals: outcome.proposals,
        findings: findings.length,
      },
      "context.sync: registry synced with the production branch",
    );
    return outcome;
  } catch (err) {
    await recordFailure(deps, scope, prior, err, repo);
    throw err;
  }
}

/** The governance mode steering/governance.toml declares at `ref`, or null. */
async function governanceModeAt(
  github: SteeringHost,
  repo: SteeringRepository,
  ref: string,
): Promise<GovernanceMode | null> {
  const text = await github.readFile(repo, GOVERNANCE_TOML_PATH, ref);
  if (text === null) return null;
  const read = readTomlFile(text, "governance/v1", governanceSchema);
  return read.ok ? resolveGovernance(read.value).mode : null;
}

/**
 * The governance change between two synced heads that no Oxagen merge made,
 * or null. It compares the modes, not the files, so a comment or an unrelated
 * setting changes nothing here. A file missing or unreadable at either head is
 * a layout change or a file problem, which the checks and health report, and
 * not a mode change. A change whose commit carries `Oxagen-Version` came
 * through landSteeringPr, which merge_steering_pr and set_governance_mode both
 * use, and each of them records its own event. Anyone who can push can write
 * that trailer too, so it counts only when Oxagen's records hold the commit
 * (oxagenMerged).
 */
async function governanceChangeOutside(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  repo: SteeringRepository,
  heads: { from: string; to: string },
  pulls: readonly { row: ProposalRow; pr: PullState }[],
): Promise<GovernanceChange | null> {
  const { github } = deps;
  const mode = await governanceModeAt(github, repo, heads.to);
  if (mode === null) return null;
  const previousMode = await governanceModeAt(github, repo, heads.from);
  if (previousMode === null || previousMode === mode) return null;
  const commit = await github.lastCommitForPath(
    repo,
    GOVERNANCE_TOML_PATH,
    heads.to,
  );
  if (commit === null) return null;
  const trailer = versionTrailer(commit.message);
  if (trailer !== null && (await oxagenMerged(deps, scope, repo, commit.sha, trailer)))
    return null;
  const carried = pulls.find(
    ({ row, pr }) =>
      row.kind === "governance" && pr.merged && pr.mergeCommitSha === commit.sha,
  );
  return {
    previousMode,
    mode,
    commitSha: commit.sha,
    proposalId: carried?.row.publicId ?? null,
    pullRequest: carried?.row.prUrl ?? null,
  };
}

/**
 * Whether Oxagen merged `commitSha`: a governance proposal it merged names
 * the commit, or the steering version store holds the commit at the version
 * its trailer names. The trailer alone proves nothing, because anyone who can
 * push to the production branch can write it (#4795).
 */
async function oxagenMerged(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  repo: SteeringRepository,
  commitSha: string,
  trailer: number,
): Promise<boolean> {
  if (await deps.store.governanceMergedAt(scope, commitSha)) return true;
  const stored = await deps.steeringVersionAt?.(scope, repo, commitSha);
  return stored?.version === trailer;
}

/**
 * Record a governance change that landed outside Oxagen. Nobody in Oxagen
 * made it, so the actor is null. It skipped the review route whenever the mode
 * it replaced asked for one, so it records `steering.governance_overridden`
 * then too, as set_governance_mode does for Apply now.
 */
function recordGovernanceChange(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  repo: SteeringRepository,
  change: GovernanceChange,
): void {
  if (!deps.emit) return;
  const overrodeReview = change.previousMode !== "solo";
  const base = {
    actorUserId: null,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    capability: null,
    outcome: "success" as const,
    ip: null,
    userAgent: null,
    requestId: null,
    detail: {
      fullName: repo.fullName,
      productionBranch: repo.defaultBranch,
      previousMode: change.previousMode,
      mode: change.mode,
      commitSha: change.commitSha,
      overrodeReview,
      landedOutsideOxagen: true,
      ...(change.proposalId !== null
        ? { proposalId: change.proposalId, pullRequest: change.pullRequest }
        : {}),
    },
  };
  deps.emit({ ...base, eventType: "steering.governance_changed" });
  if (overrodeReview)
    deps.emit({ ...base, eventType: "steering.governance_overridden" });
}

/**
 * 8. Publish the workspace's steering repository. The registry write above
 * already stands, so a publish that throws is logged and the sync still
 * succeeds. The next sync publishes the steering repository's head then.
 */
async function publishSteering(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
): Promise<SyncPublished | null> {
  if (deps.publish === undefined) return null;
  try {
    return await deps.publish(scope);
  } catch (err) {
    logger.warn(
      { err, workspaceId: scope.workspaceId },
      "context.sync: could not publish the steering version. The next sync tries again.",
    );
    return null;
  }
}

async function reject(
  deps: SyncDeps,
  repo: SteeringRepository,
  row: ProposalRow,
  reason: string,
  at: Date,
  noClaimSince: Date,
): Promise<boolean> {
  try {
    await deps.steering.updateProposal(
      row.id,
      // No person closed it: the host did, and the page reads a null updater
      // on a rejected proposal as a close on the host.
      {
        status: "rejected",
        dismissedAt: at,
        dismissedReason: reason,
        updatedById: null,
      },
      OPEN_PR,
      { noClaimSince },
    );
  } catch (err) {
    // Another call moved it first: a merge from Oxagen, or a dismissal. Or a
    // merge from Oxagen claimed it after this sync read it.
    if (err instanceof HandlerError && err.code === "conflict") return false;
    throw err;
  }
  await dropBranch(deps, repo, row);
  return true;
}

/**
 * Delete a settled steering PR's branch, as `dismiss_proposal` and
 * `merge_steering_pr` do. The next proposal on the lineage branches from the
 * production branch; a stale branch left behind on the lineage would carry
 * the old PR's commits into it. Best effort: a branch already gone is fine, and a
 * refusal is logged rather than failing the sync.
 */
async function dropBranch(
  deps: SyncDeps,
  repo: SteeringRepository,
  row: ProposalRow,
): Promise<void> {
  if (!row.branch) return;
  try {
    await deps.github.deleteBranch(repo, row.branch);
  } catch (err) {
    logger.warn(
      { err, proposal: row.publicId, branch: row.branch },
      "context.sync: could not delete a settled steering PR's branch",
    );
  }
}

/**
 * Keep the last good head and findings, and say why this run failed. A head
 * the prior state took from another steering repository is not kept: stored
 * beside the new repository's name, it would make the next run read that
 * repository at the old repository's sha, and a reconcile there could remove
 * heads on a list the new repository never held.
 */
async function recordFailure(
  deps: SyncDeps,
  scope: { orgId: string; workspaceId: string },
  prior: SyncState | null,
  err: unknown,
  repo?: SteeringRepository,
): Promise<void> {
  const kept =
    repo === undefined ||
    (prior?.provider === repo.provider && prior?.repository === repo.fullName)
      ? prior
      : null;
  try {
    await deps.store.writeState(scope, {
      provider: repo?.provider ?? prior?.provider ?? null,
      repository: repo?.fullName ?? prior?.repository ?? null,
      branch: repo?.defaultBranch ?? prior?.branch ?? null,
      headSha: kept?.headSha ?? null,
      rulesSha: kept?.rulesSha ?? null,
      status: "failed",
      findings: kept?.findings ?? [],
      error: err instanceof Error ? err.message : String(err),
      syncedAt: deps.now(),
    });
  } catch (writeErr) {
    logger.error(
      { err: writeErr, workspaceId: scope.workspaceId },
      "context.sync: could not record the failed sync",
    );
  }
}
