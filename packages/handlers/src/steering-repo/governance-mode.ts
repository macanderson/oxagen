// steering-repo/governance-mode.ts: `set_governance_mode` in a steering
// repository (#4766, ADR-232).
//
// A steering repository keeps its mode as the top-level `mode` key of
// `steering/governance.toml`, beside the ledger, memory, and reviewer
// settings. A change rewrites that one key and keeps every other line.
//
// Nothing here commits to the production branch. Both routes push the change
// to `steering/governance` and open a steering PR that changes that one file,
// so the branch-scope rule admits it. Oxagen runs the steering checks on the
// PR's head and reports the required `Oxagen steering` check there.
//
// - Review (team or regulated): the PR stays open and waits for review. The
//   handler records it as a governance proposal, and merge_steering_pr lands
//   it for an approver through landGovernancePr below (#4795, ADR-232).
// - Land at once (solo, or the override): the PR goes through the steering
//   merge queue. The queue brings the branch up to date, stamps the ledger
//   line, squash-merges with the trailers, and publish() makes the version
//   live. A check that fails refuses the call before anything merges.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  STEERING_GOVERNANCE_BRANCH,
  STEERING_GOVERNANCE_FILE,
} from "@oxagen/oxagen/contracts/context.governance_mode.set";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import {
  governanceSchema,
  resolveGovernance,
  type GovernanceSettings,
} from "@oxagen/oxagen/steering-repo/governance";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import type { CheckReport } from "@oxagen/steering-check";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";
import { logger } from "../logger";
import { checkRunText } from "../tools.pr.open";
import {
  assertHealthy,
  inMergeQueue,
  landSteeringPr,
  readSteeringLayout,
  recordPublishDeployment,
  type LandInput,
  type MergeApproval,
  type SteeringLayout,
} from "./merge-queue";
import {
  STEERING_GOVERNANCE_PR_BODY,
  STEERING_GOVERNANCE_PR_TITLE,
} from "./governance-pr";
import type { HeldPublish, SteeringPublisher } from "./publisher";

type Scope = { orgId: string; workspaceId: string };

export {
  STEERING_GOVERNANCE_PR_BODY,
  STEERING_GOVERNANCE_PR_TITLE,
} from "./governance-pr";

/** The seams production binds. Tests pass their own. */
export interface SteeringGovernanceSeams {
  /** Run the steering checks on `head` against the production branch commit `base`. */
  check: (
    scope: Scope,
    host: SteeringHost,
    repo: SteeringRepository,
    head: string,
    base: string,
  ) => Promise<CheckReport>;
  /** The steering repo's health. While it is not healthy, nothing merges. */
  readHealth: (scope: Scope, repo: SteeringRepository) => Promise<RepoHealth>;
  /** The workspace's publisher (S5), which assigns the version the merge becomes. */
  publisher: (scope: Scope, host: SteeringHost) => Promise<SteeringPublisher>;
}

/**
 * The seams production binds. Each one imports its module on first use, so
 * loading the governance handler opens no store and no host client.
 */
export const productionSteeringGovernanceSeams: SteeringGovernanceSeams = {
  check: async (scope, host, repo, head, base) => {
    const [
      { checkSteeringChange, steeringTreeHost },
      { indexRecords, readCheckContext },
      { postgresTachoPublished },
    ] = await Promise.all([
      import("../context.steering.checks"),
      import("../context.steering.index.get"),
      import("../tacho.published.postgres"),
    ]);
    const [delivery, context] = await Promise.all([
      postgresTachoPublished.published({ ...scope, runId: null }),
      readCheckContext(scope),
    ]);
    return checkSteeringChange({
      host: steeringTreeHost(host, repo),
      head,
      base,
      index:
        delivery.workspace === null
          ? null
          : { records: indexRecords(delivery.workspace) },
      context,
      health: null,
    });
  },
  readHealth: async (scope, repo) => {
    const { readSteeringHealth } = await import("./health.read");
    return readSteeringHealth(repo, scope);
  },
  // The same publisher merge_steering_pr lands through, so a governance merge
  // takes its version from the same store under the same lock.
  publisher: async (scope, host) => {
    const { productionMergeSeams } = await import("../steering.pr.merge");
    const build = productionMergeSeams.publisher;
    if (!build) {
      throw new Error(
        "set_governance_mode: merge_steering_pr binds no steering publisher",
      );
    }
    return build(scope, host);
  },
};

function governanceRefusal(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/** The first issue a governance/v1 read found, as `line N: message`. */
function firstIssue(issues: readonly { line?: number | null; message: string }[]): string {
  const first = issues[0];
  if (!first) return "it is not governance/v1";
  return `${first.line ? `line ${first.line}: ` : ""}${first.message}`;
}

/**
 * The settings `steering/governance.toml` declares, or `governance_unreadable`.
 * The merge queue refuses every steering PR while this file does not parse,
 * so a mode change refuses too rather than guess which mode is in force.
 */
export function readSteeringGovernance(text: string): GovernanceSettings {
  const read = readTomlFile(text, "governance/v1", governanceSchema);
  if (!read.ok) {
    throw governanceRefusal(
      "governance_unreadable",
      `${STEERING_GOVERNANCE_FILE} does not parse, so Oxagen cannot tell which mode is in force (${firstIssue(read.issues)}). Fix the file on the production branch, then set the mode again.`,
    );
  }
  return resolveGovernance(read.value);
}

/** The top-level `mode = "..."` line: the key, the quoted value, and the rest (a comment). */
const MODE_LINE = /^(\s*mode\s*=\s*)(?:"[^"\n]*"|'[^'\n]*')(.*)$/;
const TABLE_HEADER = /^\s*\[/;

/**
 * `text` with its top-level `mode` set to `mode`, and every other line as it
 * was, comments included. The result is read again as governance/v1, so a
 * mode the rest of the file does not allow refuses `governance_invalid`
 * before anything is written. `[memory] auto_merge = true` outside `solo` is
 * the case that exists today.
 */
export function rewriteGovernanceMode(
  text: string,
  mode: GovernanceMode,
): string {
  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (TABLE_HEADER.test(line)) break;
    if (MODE_LINE.test(line)) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    throw governanceRefusal(
      "governance_unreadable",
      `${STEERING_GOVERNANCE_FILE} has no top-level \`mode = "..."\` line before its first table. Add one, then set the mode again.`,
    );
  }
  lines[at] = (lines[at] as string).replace(
    MODE_LINE,
    (_match, key: string, rest: string) => `${key}"${mode}"${rest}`,
  );
  const next = lines.join("\n");
  const read = readTomlFile(next, "governance/v1", governanceSchema);
  if (!read.ok) {
    throw governanceRefusal(
      "governance_invalid",
      `${STEERING_GOVERNANCE_FILE} does not allow mode "${mode}" (${firstIssue(read.issues)}). Change that setting on the production branch, then set the mode again.`,
    );
  }
  const written = resolveGovernance(read.value).mode;
  if (written !== mode) {
    throw new Error(
      `set_governance_mode: rewriting ${STEERING_GOVERNANCE_FILE} produced mode ${written}, not ${mode}`,
    );
  }
  return next;
}

/** The checks that passed, by name, as the merge queue's trailer lists them. */
export function passedCheckNames(report: CheckReport): string[] {
  return report.results
    .filter((result) => result.status === "passed")
    .map((result) => result.check);
}

export interface SteeringGovernanceInput {
  host: SteeringHost;
  repo: SteeringRepository;
  scope: Scope;
  /** The production branch commit the current file was read at. */
  productionHead: string;
  /** `steering/governance.toml` at `productionHead`. */
  currentText: string;
  /** The mode in force at `productionHead`. */
  currentMode: GovernanceMode;
  mode: GovernanceMode;
  /** Merge now through the queue, rather than leave the PR open for review. */
  land: boolean;
  /** True when the mode in force asks for review and the caller overrode it. */
  withoutReview: boolean;
  actingUserId: string;
  now: () => Date;
  seams: SteeringGovernanceSeams;
}

export interface SteeringPullRequest {
  number: number;
  htmlUrl: string;
  reused: boolean;
}

export type SteeringGovernanceResult =
  | {
      outcome: "proposed";
      pullRequest: SteeringPullRequest;
      head: string;
      /** True when every steering check passed on `head`. */
      checksPassed: boolean;
    }
  | {
      outcome: "applied";
      pullRequest: SteeringPullRequest;
      commitSha: string;
      version: number;
      deploymentUrl: string | null;
    };

/** What running and reporting the steering checks on a governance PR needs. */
export interface GovernanceCheckContext {
  host: SteeringHost;
  repo: SteeringRepository;
  scope: Scope;
  now: () => Date;
  check: SteeringGovernanceSeams["check"];
}

/** Report the required check on `head`. A failed report is logged. */
async function reportCheck(
  input: GovernanceCheckContext,
  head: string,
  report: CheckReport | null,
  error: unknown,
  startedAt: string,
): Promise<void> {
  const text =
    report === null
      ? {
          conclusion: "failure" as const,
          title: "The steering checks did not run",
          summary: `Oxagen could not run the steering checks on ${head}: ${error instanceof Error ? error.message : String(error)}. Set the mode again to run them.`,
        }
      : checkRunText(report);
  try {
    await input.host.reportCheckRun(input.repo, {
      name: REQUIRED_CHECK_NAME,
      headSha: head,
      conclusion: text.conclusion,
      title: text.title,
      summary: text.summary,
      startedAt,
      completedAt: input.now().toISOString(),
    });
  } catch (err) {
    // The branch and the PR exist. The required check stays missing, so the
    // PR cannot merge until the next call reports it.
    logger.error(
      { err, repository: input.repo.fullName, head },
      "set_governance_mode: the Oxagen steering check was not reported",
    );
  }
}

/**
 * Run the steering checks on a governance PR's `head` against the production
 * branch commit `base`, and report them as the required check. Null when they
 * did not run.
 */
export async function runGovernanceChecks(
  input: GovernanceCheckContext,
  head: string,
  base: string,
): Promise<CheckReport | null> {
  const startedAt = input.now().toISOString();
  let report: CheckReport | null = null;
  let error: unknown = null;
  try {
    report = await input.check(input.scope, input.host, input.repo, head, base);
  } catch (err) {
    error = err;
    logger.error(
      { err, repository: input.repo.fullName, head },
      "set_governance_mode: steering checks did not run",
    );
  }
  await reportCheck(input, head, report, error, startedAt);
  return report;
}

/**
 * Put `content` on `steering/governance` on top of the production head, and
 * find or open its PR. An open PR is reused. Its branch first takes in the
 * production head, so the checks compare the right trees. When that merge
 * conflicts, the stale PR is closed and a fresh one opened. A branch left
 * from a closed PR is dropped first.
 */
async function pushBranch(
  input: SteeringGovernanceInput,
  content: string,
): Promise<{ pullRequest: SteeringPullRequest; head: string }> {
  const { host, repo, productionHead } = input;
  const branch = STEERING_GOVERNANCE_BRANCH;
  let open = await host.findOpenPullRequest(repo, {
    head: branch,
    base: repo.defaultBranch,
  });
  if (open) {
    const head = await host.branchHead(repo, branch);
    if (head === null) {
      open = null;
    } else if (!(await host.holdsCommit(repo, head, productionHead))) {
      try {
        await host.updateBranch(repo, {
          number: open.number,
          branch,
          expectedHead: head,
          base: productionHead,
        });
      } catch (err) {
        if (!isHandlerError(err) || err.reason !== "update_conflict") throw err;
        // The production branch changed the same file since this PR opened.
        // The new change is read from the production branch, so the old PR
        // has nothing left to keep.
        logger.info(
          { repository: repo.fullName, pr: open.htmlUrl },
          "set_governance_mode: closing a governance PR that no longer merges",
        );
        await host.closePullRequest(repo, open.number);
        open = null;
      }
    }
  }
  if (!open) {
    await host.deleteBranch(repo, branch);
    await host.ensureBranch(repo, branch, repo.defaultBranch, {
      exclusive: false,
      at: productionHead,
    });
  }
  const { commitSha: head } = await host.putFile(repo, {
    path: STEERING_GOVERNANCE_FILE,
    content,
    message: `Set steering governance mode to ${input.mode}`,
    branch,
  });
  const pullRequest: SteeringPullRequest = open
    ? { number: open.number, htmlUrl: open.htmlUrl, reused: true }
    : {
        ...(await host.openPullRequest(repo, {
          title: STEERING_GOVERNANCE_PR_TITLE,
          head: branch,
          base: repo.defaultBranch,
          body: STEERING_GOVERNANCE_PR_BODY,
          labels: OXAGEN_PR_LABELS,
        })),
        reused: false,
      };
  return { pullRequest, head };
}

/**
 * Run `work` under the publisher's lock. A lock another publish holds refuses
 * before `work` starts, so nothing merged, and the refusal says to retry.
 */
async function underPublishLock<T>(
  publisher: SteeringPublisher,
  repo: SteeringRepository,
  work: (held: HeldPublish) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    return await publisher.withLock(repo, (held) => {
      entered = true;
      return work(held);
    });
  } catch (err) {
    if (
      !entered &&
      isHandlerError(err) &&
      err.reason === "publish_in_progress"
    ) {
      throw governanceRefusal(
        "publish_in_progress",
        `Another publish of ${repo.fullName} is running, so nothing merged. Set the mode again in a minute.`,
      );
    }
    throw err;
  }
}

/**
 * publish() at the merge commit, under the lock the merge took. True when the
 * version in the trailer is live. A failure, a refusal, or a stale commit is
 * logged for the repository sync to publish, and answers false. A different
 * version refuses, because the trailer on the merge commit names the wrong
 * number.
 */
async function publishMerged(
  held: HeldPublish,
  repo: SteeringRepository,
  commit: string,
  version: number,
): Promise<boolean> {
  let result: Awaited<ReturnType<HeldPublish>>;
  try {
    result = await held(commit);
  } catch (err) {
    logger.warn(
      { err, repository: repo.fullName, commit, version },
      "set_governance_mode: merged, but publish() failed",
    );
    return false;
  }
  if (result.status === "refused" || result.status === "stale") {
    logger.warn(
      { repository: repo.fullName, commit, version, result },
      `set_governance_mode: merged, but publish() answered ${result.status}`,
    );
    return false;
  }
  if (result.version !== version) {
    throw governanceRefusal(
      "version_mismatch",
      `${repo.fullName} merged ${commit} with Oxagen-Version: ${version}, but publish() assigned version ${result.version}. The merge stands. Correct the published version before the next merge.`,
    );
  }
  return true;
}

/** What landing a governance PR needs, whichever route lands it. */
export interface GovernanceLandInput {
  host: SteeringHost;
  repo: SteeringRepository;
  /** The production branch's layout, read inside the merge queue. */
  layout: Extract<SteeringLayout, { layout: "steering" }>;
  number: number;
  /** The head the checks passed on. */
  checkedHead: string;
  /** The checks that passed on it, by name. */
  checks: readonly string[];
  /** The mode the PR sets, named in the commit title. */
  mode: GovernanceMode;
  approve: LandInput["approve"];
  mergedBy: string;
  recheck: LandInput["recheck"];
  publisher: SteeringPublisher;
  now: () => Date;
}

export interface GovernanceLanded {
  commitSha: string;
  /** The branch head the merge was pinned to: the stamp commit. */
  mergedHead: string;
  version: number;
  /** True when publish() made `version` live. */
  live: boolean;
  deploymentUrl: string | null;
}

/**
 * Land a governance PR through the steering merge queue. Under the
 * publisher's lock it takes the version publish() assigns next, brings the
 * branch up to date, stamps the ledger line with the approval, squash-merges
 * with the trailers, deletes the branch, and publishes. It records the
 * deployment for a version that went live. The caller holds the merge queue
 * and has checked the repository's health.
 *
 * set_governance_mode lands solo and Apply now through it. merge_steering_pr
 * lands a reviewed governance proposal through it (#4795).
 */
export async function landGovernancePr(
  input: GovernanceLandInput,
): Promise<GovernanceLanded> {
  const { host, repo, publisher } = input;
  const landed = await underPublishLock(publisher, repo, async (held) => {
    const version =
      (await publisher.store.highestVersion(publisher.repository(repo))) + 1;
    const merged = await landSteeringPr({
      host,
      repo,
      number: input.number,
      branch: STEERING_GOVERNANCE_BRANCH,
      checkedHead: input.checkedHead,
      checks: input.checks,
      layout: input.layout,
      approve: input.approve,
      mergedBy: input.mergedBy,
      commitTitle: `steering: set governance mode to ${input.mode} (#${input.number})`,
      version,
      now: input.now,
      recheck: input.recheck,
    });
    await host.deleteBranch(repo, STEERING_GOVERNANCE_BRANCH);
    const live = await publishMerged(held, repo, merged.commitSha, version);
    return {
      commitSha: merged.commitSha,
      mergedHead: merged.mergedHead,
      version,
      live,
    };
  });
  const deploymentUrl = landed.live
    ? await recordPublishDeployment(host, repo, {
        sha: landed.commitSha,
        version: landed.version,
        number: input.number,
      })
    : null;
  return { ...landed, deploymentUrl };
}

/**
 * The production layout inside the merge queue, or `layout_changed` when
 * `steering/governance.toml` is gone from the production branch.
 */
export async function steeringLayoutOrRefuse(
  host: SteeringHost,
  repo: SteeringRepository,
  retry: string,
): Promise<Extract<SteeringLayout, { layout: "steering" }>> {
  const layout = await readSteeringLayout(host, repo);
  if (layout.layout !== "steering") {
    throw governanceRefusal(
      "layout_changed",
      `${repo.fullName} no longer holds ${STEERING_GOVERNANCE_FILE} on ${repo.defaultBranch}, so nothing merged. ${retry}`,
    );
  }
  return layout;
}

/**
 * Change the mode in a steering repository: push the steering PR, run and
 * report its check, and either leave it open or land it through the queue.
 */
export async function setSteeringGovernanceMode(
  input: SteeringGovernanceInput,
): Promise<SteeringGovernanceResult> {
  const { host, repo } = input;
  // Before any write: a mode the rest of the file does not allow refuses here.
  const content = rewriteGovernanceMode(input.currentText, input.mode);
  const { pullRequest, head } = await pushBranch(input, content);
  const checks: GovernanceCheckContext = {
    host,
    repo,
    scope: input.scope,
    now: input.now,
    check: input.seams.check,
  };
  const report = await runGovernanceChecks(checks, head, input.productionHead);

  if (!input.land) {
    return {
      outcome: "proposed",
      pullRequest,
      head,
      checksPassed: report?.passed === true,
    };
  }

  if (report === null || !report.passed) {
    const errors =
      report?.findings.filter((finding) => finding.severity === "error") ?? [];
    const first = errors[0];
    const why =
      report === null
        ? "the steering checks did not run"
        : `the steering checks found ${errors.length} ${errors.length === 1 ? "error" : "errors"}${first ? `, first ${first.check}: ${first.message}` : ""}`;
    throw governanceRefusal(
      "steering_check_failed",
      `Nothing merged, because ${why}. ${pullRequest.htmlUrl} stays open with the report. Fix the finding, then set the mode again.`,
    );
  }

  // Two routes land here, and neither reads the host's approvals. Solo needs
  // none, so the caller is the approver. Apply now in team or regulated is an
  // explicit override: nobody approved it, and the ledger says so (ADR-232).
  const approval: MergeApproval = input.withoutReview
    ? { approvedBy: [], withoutReview: true }
    : { approvedBy: [input.actingUserId], withoutReview: false };

  return inMergeQueue(repo, async () => {
    assertHealthy(await input.seams.readHealth(input.scope, repo), repo);
    const layout = await steeringLayoutOrRefuse(
      host,
      repo,
      "Set the mode again.",
    );
    const landed = await landGovernancePr({
      host,
      repo,
      layout,
      number: pullRequest.number,
      checkedHead: head,
      checks: passedCheckNames(report),
      mode: input.mode,
      approve: async () => approval,
      mergedBy: input.actingUserId,
      // The queue merged the production branch into the PR's branch. The
      // checks compare the new head with the production head it now holds.
      recheck: async (next) => {
        const base = await host.branchHead(repo, repo.defaultBranch);
        const again =
          base === null ? null : await runGovernanceChecks(checks, next, base);
        return again === null
          ? { ok: false, checks: [] }
          : { ok: again.passed, checks: passedCheckNames(again) };
      },
      publisher: await input.seams.publisher(input.scope, host),
      now: input.now,
    });
    return {
      outcome: "applied" as const,
      pullRequest,
      commitSha: landed.commitSha,
      version: landed.version,
      deploymentUrl: landed.deploymentUrl,
    };
  });
}
