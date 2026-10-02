// code-repo-check-runner.ts: the seam between the durable job that checks a
// pull request in a linked code repository (functions/code-repo.check.ts)
// and the code that reads the host and posts the Oxagen check (S2b, #5058).
//
// The check lives in `@oxagen/handlers/code-repo-check`, which depends on this
// package, so this package cannot import it. The handlers' register module
// installs the runner when the API process boots, before the Inngest route
// can invoke a function.

/** The event the GitHub and GitLab webhooks send for one pull request. */
export const CODE_REPO_CHECK_REQUESTED_EVENT = "code-repo/check.requested";

/** The hosts a linked code repository can live on. */
export type CodeRepoProvider = "github" | "gitlab";

/**
 * One check of one pull request head, for one workspace that links the
 * repository. A repository linked by several workspaces gets one request per
 * workspace, and each is read in that workspace's tenant scope.
 */
export interface CodeRepoCheckRequest {
  orgId: string;
  workspaceId: string;
  provider: CodeRepoProvider;
  /** The host's immutable id: GitHub's numeric repository id, or GitLab's project id. */
  repositoryId: string;
  /** `owner/name` on GitHub, the project path with its groups on GitLab. */
  fullName: string;
  /** The pull request number, or the merge request IID on GitLab. */
  number: number;
  /** The pull request's page, which memories cite as evidence. */
  url: string;
  /** The commit the check is posted on. */
  headSha: string;
  /** What the head is compared with: the base commit on GitHub, the target branch on GitLab. */
  base: string;
  /** The Oxagen GitHub App installation that delivered the event. GitHub only. */
  installationId: number | null;
  /** The GitLab connection whose token reads the project. GitLab only. */
  connectionId: string | null;
  /** One check at a time per pull request: `<workspaceId>:<provider>:<repositoryId>:<number>`. */
  key: string;
}

/** What one check posted. */
export interface CodeRepoCheckOutcome {
  conclusion: "success" | "neutral" | "failure";
  /** Instruction files the pull request changes. */
  files: number;
  findings: number;
  /** New lines handed to S6's memory capture, less any it refused. */
  memories: number;
}

export type CodeRepoCheckRunner = (
  request: CodeRepoCheckRequest,
) => Promise<CodeRepoCheckOutcome>;

let runner: CodeRepoCheckRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setCodeRepoCheckRunner(next: CodeRepoCheckRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function codeRepoCheckRunner(): CodeRepoCheckRunner {
  if (!runner)
    throw new Error(
      "[code-repo.check] no code repository check runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
