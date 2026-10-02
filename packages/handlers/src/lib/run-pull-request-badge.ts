// The Oxagen block and the `oxagen` label on a pull request a wrapped agent
// opened (#5059, ADR-252).
//
// The run record says which pull requests a run opened. A `pr_open` effect
// frame holds the URL that a `github__create_pull_request` call or a
// `gh pr create` line printed, and the ingest marks that link as opened
// (run-pull-request-links.ts). For each one, the backfill
// (run-pull-request-backfill.ts) calls `markRunPullRequest`, which:
//
//   1. reads the pull request with the Oxagen GitHub App's installation token,
//   2. puts the Oxagen block at the top of the description, or refreshes the
//      block where it already is, and writes the description only when the
//      block changed, and
//   3. adds the `oxagen` label when the pull request does not carry it.
//
// The block is a managed block, with the markers and hash the steering repo
// files use (steering-repo/templates.ts). Oxagen edits the text between the
// markers and nothing else in the description. So a second run of this step
// on the same pull request changes nothing.
import {
  getInstallationToken,
  type GitHubClient,
} from "@oxagen/github";
import {
  readManagedBlock,
  renderManagedBlock,
} from "@oxagen/oxagen/steering-repo";

/**
 * The badge image, the one place the product names it. The brand kit
 * (oxageninc/brand) draws it in `build/badges.py`, and brand.oxagen.cloud
 * serves it after a push to the kit's `main` passes its checks.
 */
export const AGENT_RUN_BADGE_URL =
  "https://brand.oxagen.cloud/github-badges/shield-oxagen-agent-run.svg";

/** The label on every pull request a wrapped agent opened. */
export const AGENT_PR_LABEL = "oxagen";

/** The label's color: the brand's ink. Gold marks identity, not a label. */
const AGENT_PR_LABEL_COLOR = "09090B";
const AGENT_PR_LABEL_DESCRIPTION =
  "Opened by an agent during a run Oxagen recorded";

/** How a description changed. */
export type BlockChange = "added" | "refreshed" | "unchanged" | "malformed";

/** What the badge step did to one pull request. */
export type BadgeMarks = { block: BlockChange; label: "added" | "present" };

/**
 * The badge step's result, for the backfill's step output and its logs.
 * `skipped` names why nothing was asked of GitHub, or why GitHub refused.
 * `failed` is any other error. Neither touches the run or its record.
 */
export type PullRequestBadgeOutcome =
  | ({ status: "marked" } & BadgeMarks)
  | {
      status: "skipped";
      reason: "not_github" | "no_installation" | "no_app" | "refused";
    }
  | { status: "failed" };

/** The calls the badge step makes on GitHub. */
export type BadgeClient = Pick<
  GitHubClient,
  "getPullRequest" | "updatePullRequest" | "createLabel" | "addLabels"
>;

/** The pull request, by owner, repository, and number. */
export type PullRequestTarget = { owner: string; repo: string; number: number };

/**
 * The block's text: the badge, linked to the run's page when there is one.
 * @internal Exported for its unit test.
 */
export function agentRunBlock(runUrl: string | null): string {
  const badge = `![oxagen: agent run](${AGENT_RUN_BADGE_URL})`;
  return renderManagedBlock(runUrl === null ? badge : `[${badge}](${runUrl})`);
}

/**
 * The description with `block` in it.
 *
 * - A description with no block gets it at the top, above a blank line.
 * - A description with a block gets the new block in the same place, and the
 *   text around it stays as it was.
 * - A description whose markers do not pair up stays as it is, because
 *   Oxagen cannot tell where its text ends and the author's begins.
 *
 * GitHub's web form saves a description with CRLF line ends, and the markers
 * are read line by line, so the text is read with LF line ends. The body that
 * comes back uses LF, and the caller writes it only when the block changed.
 * @internal Exported for its unit test.
 */
export function withAgentRunBlock(
  body: string | null,
  block: string,
): { change: BlockChange; body: string } {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const read = readManagedBlock(text);
  if (!read.ok) return { change: "malformed", body: text };
  if (read.block === null) {
    return {
      change: "added",
      body: text.trim() === "" ? block : `${block}\n${text}`,
    };
  }
  const lines = text.split("\n");
  const next = [
    ...lines.slice(0, read.block.begin_line - 1),
    ...block.replace(/\n$/, "").split("\n"),
    ...lines.slice(read.block.end_line),
  ].join("\n");
  return next === text
    ? { change: "unchanged", body: text }
    : { change: "refreshed", body: next };
}

/**
 * Put the block and the label on one pull request. The description is
 * written only when the block changed, and the label is added only when the
 * pull request does not carry it, so a second call writes nothing.
 */
export async function markRunPullRequest(
  client: BadgeClient,
  target: PullRequestTarget,
  runUrl: string | null,
): Promise<BadgeMarks> {
  const pr = await client.getPullRequest(target);
  const edit = withAgentRunBlock(pr.body, agentRunBlock(runUrl));
  if (edit.change === "added" || edit.change === "refreshed") {
    // The body alone: a title someone changed since the read stays.
    await client.updatePullRequest({ ...target, body: edit.body });
  }
  // GitHub matches a label name without regard to case, so `Oxagen` on the
  // pull request already counts.
  if (pr.labels.some((name) => name.toLowerCase() === AGENT_PR_LABEL)) {
    return { block: edit.change, label: "present" };
  }
  await client.createLabel({
    owner: target.owner,
    repo: target.repo,
    name: AGENT_PR_LABEL,
    color: AGENT_PR_LABEL_COLOR,
    description: AGENT_PR_LABEL_DESCRIPTION,
  });
  await client.addLabels({ ...target, labels: [AGENT_PR_LABEL] });
  return { block: edit.change, label: "added" };
}

/**
 * The run's page in the app, or null when the deployment names no app
 * origin or the origin does not parse.
 * @internal Exported for its unit test.
 */
export function runPageUrl(
  appUrl: string | undefined,
  run: { orgSlug: string; workspaceSlug: string; runId: string },
): string | null {
  if (!appUrl) return null;
  const path = [run.orgSlug, run.workspaceSlug, "runs", run.runId]
    .map(encodeURIComponent)
    .join("/");
  try {
    return new URL(`/${path}`, appUrl).href;
  } catch {
    return null;
  }
}

/**
 * An installation token that can edit pull requests in one repository, and
 * nothing else. The Oxagen GitHub App holds pull request write on the code
 * repositories it is installed on (steering-repo-spec, Pull request badges).
 * Null when the deployment has no app settings. `refused` when GitHub will
 * not mint one: the installation does not include the repository, or does
 * not grant the permission.
 */
export async function badgeInstallationToken(
  installationId: string,
  repo: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null | "refused"> {
  const appId = env["GITHUB_APP_ID"];
  const privateKey = env["GITHUB_APP_PRIVATE_KEY"];
  if (!appId || !privateKey) return null;
  try {
    const { token } = await getInstallationToken({
      appId,
      privateKey,
      installationId,
      repositories: [repo],
      permissions: { pull_requests: "write", metadata: "read" },
    });
    return token;
  } catch (err) {
    // The mint names GitHub's status in its message: "(403)", "(404)", or
    // "(422)" when the installation cannot reach the repository or grant
    // the permission.
    if (err instanceof Error && /\((403|404|422)\)/.test(err.message))
      return "refused";
    throw err;
  }
}
