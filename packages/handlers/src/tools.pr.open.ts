// tools.pr.open.ts: the one write path for a tools steering PR (lane M11;
// steering-repo-spec, Steering PR flow).
//
// Studio's Review, M10's sync, and M13's server folder writer each change
// files under tools/servers/<name>/. They all open the steering PR here.
//
// Without `existing`:
//   1. Refuse a branch outside tools/, a path outside the branch's folder,
//      more than 299 files, or a repository without steering/governance.toml.
//   2. Create the branch at `at`, the commit the caller built the files
//      against, or at the production head when the caller names none. A
//      branch that already exists is refused, so two writers never share one.
//   3. Write every file in one commit on that commit. Null content deletes.
//   4. Open the PR into the production branch with OXAGEN_PR_LABELS. When
//      the create call fails, look for an open PR on the branch. Adopt one
//      if it exists. Delete the branch only when none does, so a retry can
//      create it. Keep the branch when the lookup fails too.
//   5. Run the steering PR checks on the new head and report the result as
//      the "Oxagen steering" check. A report that fails is logged. The PR is
//      open, and the missing required check blocks its merge.
//
// With `existing`, step 2 finds that PR open on the branch and targeting the
// production branch, step 3 adds one commit on the branch's head, and step 4
// replaces the PR's title and body. When the caller names `at` and the
// branch moved off it, the call is refused before it writes.
//
// The host is either GitHub or GitLab: createSteeringHost() routes each call
// by the repository's provider. A person's role is not checked here, because
// M10's sync runs with no person. Each capability that calls this checks the
// caller's role first.
import type { SteeringPrOpener } from "@oxagen/agent/runtime/steering-pr";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import {
  formatHuman,
  type CheckInput,
  type CheckReport,
} from "@oxagen/steering-check";
import {
  checkSteeringChange,
  steeringTreeHost,
} from "./context.steering.checks";
import type {
  SteeringHost,
  SteeringRepository,
} from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import { logger } from "./logger";
import { readSteeringLayout } from "./steering-repo/merge-queue";
import {
  STEERING_PR_MAX_FILES,
  branchScopeRefusal,
} from "./steering-repo/stamp";

export interface ToolsPullRequestScope {
  orgId: string;
  workspaceId: string;
}

/** One file the commit writes. Null content deletes the file. */
export interface ToolsPullRequestFile {
  path: string;
  content: string | null;
}

export interface ToolsPullRequestArgs {
  /** Starts with tools/, such as tools/billing or tools/sync-billing-20260928t1500. */
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: ToolsPullRequestFile[];
  /** The open PR on `branch` to add a commit to, instead of opening one. */
  existing?: { number: number };
  /**
   * The commit the caller read to build `files`. A new branch starts here
   * instead of at the production head. With `existing`, the call is refused
   * when the branch's head is not this commit.
   */
  at?: string;
}

export interface ToolsPullRequestResult {
  number: number;
  url: string;
  branch: string;
  /** The commit this call wrote, which the "Oxagen steering" check ran on. */
  headSha: string;
}

/** The shape M10's ToolsPullRequestOpener seam declares. */
export interface ToolsPullRequestOpener {
  open(
    scope: ToolsPullRequestScope,
    args: ToolsPullRequestArgs,
  ): Promise<ToolsPullRequestResult>;
}

export type ToolsPullRequestHost = Pick<
  SteeringHost,
  | "resolveRepository"
  | "readFile"
  | "listFiles"
  | "branchHead"
  | "ensureBranch"
  | "deleteBranch"
  | "commitFiles"
  | "openPullRequest"
  | "updatePullRequest"
  | "findOpenPullRequest"
  | "reportCheckRun"
>;

export interface ToolsPullRequestDeps {
  host: () => ToolsPullRequestHost;
  /** The workspace's published records, or null before its first publish. */
  readIndex: (scope: ToolsPullRequestScope) => Promise<CheckInput["index"]>;
  /** The names the references check resolves against. */
  readContext: (
    scope: ToolsPullRequestScope,
  ) => Promise<CheckInput["context"]>;
  now: () => Date;
}

/** The branch folder every tools steering PR lives under. */
export const TOOLS_BRANCH_PREFIX = "tools/";

/** GitHub cuts a check run's summary at 65,535 characters. */
const CHECK_SUMMARY_MAX = 60_000;

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/** Why the arguments cannot become one tools steering PR, or null. */
export function toolsPullRequestRefusal(
  args: Pick<ToolsPullRequestArgs, "branch" | "files">,
): { reason: string; message: string } | null {
  if (!args.branch.startsWith(TOOLS_BRANCH_PREFIX)) {
    return {
      reason: "branch_prefix",
      message: `${args.branch} does not start with ${TOOLS_BRANCH_PREFIX}. A tools steering PR changes only tools/.`,
    };
  }
  if (args.files.length === 0) {
    return {
      reason: "no_files",
      message: "The commit names no files. Add at least one file to write or delete.",
    };
  }
  if (args.files.length > STEERING_PR_MAX_FILES) {
    return {
      reason: "too_many_files",
      message: `The commit changes ${args.files.length} files, and a steering PR changes at most ${STEERING_PR_MAX_FILES}. Split the change into more PRs.`,
    };
  }
  const paths = args.files.map((file) => file.path);
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      return {
        reason: "duplicate_path",
        message: `${path} appears twice in the commit. Name each file once.`,
      };
    }
    seen.add(path);
  }
  return branchScopeRefusal(args.branch, paths);
}

/** The check run's title and summary for one report. */
export function checkRunText(report: CheckReport): {
  conclusion: "success" | "failure";
  title: string;
  summary: string;
} {
  const errors = report.findings.filter(
    (finding) => finding.severity === "error",
  ).length;
  const text = formatHuman(report);
  const summary =
    text.length > CHECK_SUMMARY_MAX
      ? `${text.slice(0, CHECK_SUMMARY_MAX)}\n\nThe report is cut here. Run oxagen check on the branch for every finding.\n`
      : text;
  return report.passed
    ? { conclusion: "success", title: "Steering checks passed", summary }
    : {
        conclusion: "failure",
        title: `${errors} ${errors === 1 ? "error" : "errors"} in the steering checks`,
        summary,
      };
}

export function createToolsPullRequestOpener(
  deps: ToolsPullRequestDeps,
): ToolsPullRequestOpener {
  /** Run the checks on `head` and report them on the host. */
  async function reportChecks(
    host: ToolsPullRequestHost,
    repo: SteeringRepository,
    scope: ToolsPullRequestScope,
    head: string,
    base: string,
  ): Promise<void> {
    const startedAt = deps.now().toISOString();
    let result: ReturnType<typeof checkRunText>;
    try {
      const [index, context] = await Promise.all([
        deps.readIndex(scope),
        deps.readContext(scope),
      ]);
      const report = await checkSteeringChange({
        host: steeringTreeHost(host, repo),
        head,
        base,
        index,
        context,
        health: null,
      });
      result = checkRunText(report);
    } catch (err) {
      // The PR is open. A failed check blocks its merge, and the message
      // says why the checks did not run.
      logger.error(
        { err, orgId: scope.orgId, workspaceId: scope.workspaceId, head },
        "tools.pr.open: steering checks did not run",
      );
      result = {
        conclusion: "failure",
        title: "The steering checks did not run",
        summary: `Oxagen could not run the steering checks on ${head}: ${err instanceof Error ? err.message : String(err)}. Push a commit to the branch to run them again.`,
      };
    }
    try {
      await host.reportCheckRun(repo, {
        name: REQUIRED_CHECK_NAME,
        headSha: head,
        conclusion: result.conclusion,
        title: result.title,
        summary: result.summary,
        startedAt,
        completedAt: deps.now().toISOString(),
      });
    } catch (err) {
      // The commit and the PR exist. Throwing here would tell the caller
      // nothing was written, and a retry would find the branch taken. The
      // required check stays missing, so the PR cannot merge until a push
      // reports it.
      logger.error(
        { err, orgId: scope.orgId, workspaceId: scope.workspaceId, head },
        "tools.pr.open: the Oxagen steering check was not reported",
      );
    }
  }

  /**
   * The PR on `branch` after its create call failed, or null once the branch
   * is dealt with. GitHub and GitLab can open the PR and still fail the call,
   * such as when the answer times out. Deleting that PR's branch would close
   * it on GitHub and strand it on GitLab, so the branch goes only when the
   * lookup finds no PR. When the lookup fails too, the branch stays: a retry
   * is refused as tools_branch_exists, which is safer than a closed PR.
   */
  async function afterFailedOpen(
    host: ToolsPullRequestHost,
    repo: SteeringRepository,
    scope: ToolsPullRequestScope,
    branch: string,
    base: string,
  ): Promise<{ number: number; htmlUrl: string } | null> {
    const context = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      branch,
    };
    let open: Awaited<ReturnType<ToolsPullRequestHost["findOpenPullRequest"]>>;
    try {
      open = await host.findOpenPullRequest(repo, { head: branch, base });
    } catch (lookupErr) {
      logger.error(
        { ...context, err: lookupErr },
        "tools.pr.open: the branch was kept because the PR lookup failed after the PR did not open",
      );
      return null;
    }
    if (open !== null) {
      logger.warn(
        { ...context, number: open.number },
        "tools.pr.open: the PR opened although its create call failed, so the opener adopted it",
      );
      return { number: open.number, htmlUrl: open.htmlUrl };
    }
    // A branch with no PR would refuse every retry as tools_branch_exists.
    try {
      await host.deleteBranch(repo, branch);
    } catch (cleanupErr) {
      logger.error(
        { ...context, err: cleanupErr },
        "tools.pr.open: the branch of a PR that did not open was not deleted",
      );
    }
    return null;
  }

  return {
    async open(scope, args) {
      const refusal = toolsPullRequestRefusal(args);
      if (refusal) throw refuse(refusal.reason, refusal.message);

      const host = deps.host();
      const repo = await host.resolveRepository(scope);
      const layout = await readSteeringLayout(host as SteeringHost, repo);
      if (layout.layout !== "steering") {
        throw refuse(
          "steering_repo_required",
          `${repo.fullName} has no steering/governance.toml on ${repo.defaultBranch}. Set up the steering repo before you open a tools steering PR.`,
        );
      }
      const production = repo.defaultBranch;
      const productionHead = await host.branchHead(repo, production);
      if (productionHead === null) {
        throw refuse(
          "production_branch_missing",
          `${repo.fullName} has no ${production} branch.`,
        );
      }

      if (args.existing === undefined) {
        if ((await host.branchHead(repo, args.branch)) !== null) {
          throw refuse(
            "tools_branch_exists",
            `${args.branch} already exists. Add to its open PR, or delete the branch and try again.`,
          );
        }
        // The files were built against `at`. Starting the branch at a newer
        // production head would revert whatever merged in between.
        const base = args.at ?? productionHead;
        await host.ensureBranch(repo, args.branch, production, {
          exclusive: true,
          at: base,
        });
        const { sha } = await host.commitFiles(repo, {
          branch: args.branch,
          parent: base,
          message: args.commitMessage,
          files: args.files,
        });
        let pr: { number: number; htmlUrl: string };
        try {
          pr = await host.openPullRequest(repo, {
            title: args.title,
            head: args.branch,
            base: production,
            body: args.body,
            labels: OXAGEN_PR_LABELS,
          });
        } catch (err) {
          const adopted = await afterFailedOpen(
            host,
            repo,
            scope,
            args.branch,
            production,
          );
          if (adopted === null) throw err;
          pr = adopted;
        }
        await reportChecks(host, repo, scope, sha, base);
        return {
          number: pr.number,
          url: pr.htmlUrl,
          branch: args.branch,
          headSha: sha,
        };
      }

      // The PR must still be open, on this branch, and into the production
      // branch. findOpenPullRequest answers all three in one read.
      const open = await host.findOpenPullRequest(repo, {
        head: args.branch,
        base: production,
      });
      if (open === null || open.number !== args.existing.number) {
        throw refuse(
          "tools_pr_not_open",
          `No open PR #${args.existing.number} merges ${args.branch} into ${production}. Open a new tools steering PR instead.`,
        );
      }
      const parent = await host.branchHead(repo, args.branch);
      if (parent === null) {
        throw refuse(
          "tools_branch_missing",
          `${args.branch} is gone from ${repo.fullName}. Open a new tools steering PR instead.`,
        );
      }
      // The files hold only what differs from the branch at `at`. On any
      // other head, the commit would drop or undo what the new commits wrote.
      if (args.at !== undefined && parent !== args.at) {
        throw refuse(
          "tools_branch_moved",
          `${args.branch} moved while the files were built. Read the branch again and retry.`,
        );
      }
      const { sha } = await host.commitFiles(repo, {
        branch: args.branch,
        parent,
        message: args.commitMessage,
        files: args.files,
      });
      const pr = await host.updatePullRequest(repo, {
        number: open.number,
        title: args.title,
        body: args.body,
      });
      await reportChecks(host, repo, scope, sha, productionHead);
      return {
        number: pr.number,
        url: pr.htmlUrl,
        branch: args.branch,
        headSha: sha,
      };
    },
  };
}

/** The workspace's steering host, built on first use, so importing this file opens no host client. */
export const toolsSteeringHost: () => ToolsPullRequestHost = (() => {
  let host: ToolsPullRequestHost | null = null;
  return () => (host ??= createSteeringHost());
})();

/** The opener over the workspace's steering host and published index. */
export const toolsPullRequestOpener: ToolsPullRequestOpener =
  createToolsPullRequestOpener({
    host: toolsSteeringHost,
    readIndex: async (scope) => {
      const { postgresTachoPublished } = await import(
        "./tacho.published.postgres"
      );
      const { indexRecords } = await import("./context.steering.index.get");
      const delivery = await postgresTachoPublished.published({
        ...scope,
        runId: null,
      });
      return delivery.workspace === null
        ? null
        : { records: indexRecords(delivery.workspace) };
    },
    readContext: async (scope) => {
      const { readCheckContext } = await import(
        "./context.steering.index.get"
      );
      return readCheckContext(scope);
    },
    now: () => new Date(),
  });

/**
 * M13's SteeringPrOpener (@oxagen/agent/runtime/steering-pr) over a tools
 * steering PR opener, so the server folder writer in mcp-studio/migrate.ts
 * opens its PRs through the same path as Studio's Review. Boot registers it:
 *
 *   registerSteeringPrOpener(steeringPrOpener)
 */
export function createSteeringPrOpener(
  opener: ToolsPullRequestOpener,
  host: () => Pick<ToolsPullRequestHost, "resolveRepository" | "readFile">,
): SteeringPrOpener {
  return {
    async hasSteeringRepo(scope) {
      const steering = host();
      let repo: SteeringRepository;
      try {
        repo = await steering.resolveRepository(scope);
      } catch (err) {
        // No connected repository is the one answer that means "no". Any
        // other failure propagates, so a registry write never falls back to a
        // direct row write because the host was down.
        if (isHandlerError(err) && err.reason === "workspace_repository_missing")
          return false;
        throw err;
      }
      // readSteeringLayout reads only readFile from the host.
      const layout = await readSteeringLayout(steering as SteeringHost, repo);
      return layout.layout === "steering";
    },
    async open(request) {
      const opened = await opener.open(
        { orgId: request.orgId, workspaceId: request.workspaceId },
        {
          branch: request.branch,
          title: request.title,
          body: request.body,
          commitMessage: request.title,
          files: request.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        },
      );
      return { number: opened.number, url: opened.url, branch: opened.branch };
    },
    async readFile(scope, path) {
      const steering = host();
      const repo = await steering.resolveRepository(scope);
      return steering.readFile(repo, path, repo.defaultBranch);
    },
  };
}

/** The SteeringPrOpener boot registers for M13's server folder writer. */
export const steeringPrOpener: SteeringPrOpener = createSteeringPrOpener(
  toolsPullRequestOpener,
  toolsSteeringHost,
);
