import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import {
  codeRepoCheckRunner,
  type CodeRepoCheckRequest,
} from "../lib/code-repo-check-runner";
import { logger } from "../logger";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** The request an event carries, or null when a field is missing. */
export function codeRepoCheckRequestOf(
  data: unknown,
): CodeRepoCheckRequest | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const orgId = str(d.orgId);
  const workspaceId = str(d.workspaceId);
  const provider = d.provider === "github" || d.provider === "gitlab" ? d.provider : null;
  const repositoryId = str(d.repositoryId);
  const fullName = str(d.fullName);
  const url = str(d.url);
  const headSha = str(d.headSha);
  const base = str(d.base);
  const key = str(d.key);
  const number = typeof d.number === "number" && Number.isInteger(d.number) && d.number > 0 ? d.number : null;
  const installationId =
    typeof d.installationId === "number" && Number.isInteger(d.installationId) ? d.installationId : null;
  const connectionId = str(d.connectionId);
  if (
    !orgId ||
    !workspaceId ||
    !provider ||
    !repositoryId ||
    !fullName ||
    !url ||
    !headSha ||
    !base ||
    !key ||
    number === null
  )
    return null;
  // Each host needs its own credential: the App installation on GitHub, the
  // stored connection on GitLab.
  if (provider === "github" && installationId === null) return null;
  if (provider === "gitlab" && connectionId === null) return null;
  return {
    orgId,
    workspaceId,
    provider,
    repositoryId,
    fullName,
    number,
    url,
    headSha,
    base,
    installationId,
    connectionId,
    key,
  };
}

/**
 * Post the Oxagen check on one pull request in a linked code repository
 * (S2b, #5058; steering-repo-spec, Code repository checks).
 *
 * The GitHub App webhook and the GitLab project webhook send
 * `code-repo/check.requested` once per workspace that links the repository,
 * with an event id per head commit, so a redelivery runs once. The runner
 * reads the instruction files the pull request changes, compares what they
 * add with the workspace's published steering records, hands new lines to
 * S6's memory capture, and posts the check. One check runs at a time per pull
 * request and workspace, so two pushes in a row cannot post out of order. A
 * host error throws, and Inngest retries the check.
 */
export const [codeRepoCheck] = createFunction(
  {
    id: "code-repo/check",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.key" },
  },
  { event: "code-repo/check.requested" },
  async ({ event, step }) => {
    const request = codeRepoCheckRequestOf(event.data);
    if (request === null)
      throw new NonRetriableError(
        "code-repo/check.requested is missing a field the check needs: the workspace, the repository, the pull request, or the host credential.",
      );
    const outcome = await step.run("check", () =>
      codeRepoCheckRunner()(request),
    );
    logger.info(
      {
        workspaceId: request.workspaceId,
        provider: request.provider,
        repositoryId: request.repositoryId,
        number: request.number,
        conclusion: outcome.conclusion,
        files: outcome.files,
        findings: outcome.findings,
        memories: outcome.memories,
      },
      "code-repo.check: posted the Oxagen check",
    );
    return outcome;
  },
);
