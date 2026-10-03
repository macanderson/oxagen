// adopt.ts: adopt host merges of pull requests Oxagen opened (#5195).
//
// A steering repo whose owner merged one of Oxagen's own pull requests on
// GitHub reads `diverged`, because a merge on the host proves nothing about
// who approved it (./diverged.ts). Repair then offers only the revert, which
// throws away the change the person was told to land. Adoption is the other
// way out: a person the governance mode lets merge decides, in Oxagen, that
// those merges stand.
//
// The adoption is refused unless every commit on main since the published one
// is an app merge, an earlier adoption, or a host merge it can prove:
//
//   - GitHub says a pull request merged into main as exactly that commit, and
//     the steering app did not merge it.
//   - Oxagen opened that pull request: a proposal row in this workspace names
//     its number, and the head it merged is the head the row recorded.
//   - The commit changes exactly the files the pull request changes, with the
//     same blobs, so nothing rode in with the merge.
//
// Nothing is written into the repository's history. Each adopted commit gets
// the app's adoption check run, which every later history read counts as
// Oxagen's, and the adoption is recorded as a `steering.published` security
// event naming the adopter and the commits. The health is read again, which
// reads healthy, and the production branch is published as the next steering
// version, with its deployment. GitLab keeps its trailer checks and is not
// covered yet.
import { HandlerError } from "@oxagen/oxagen";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import type { SecurityEventInput } from "@oxagen/telemetry";
import { mergeRefusal } from "../context.steering.policy";
import { logger } from "../logger";
import {
  type GithubHistoryTarget,
  githubHostMerge,
  githubPublished,
  githubRecordAdoption,
  githubSameChanges,
  githubUnproven,
} from "./diverged";
import type { HealthOutcome, HealthRow, HealthScope, HealthTrigger } from "./health";
import type { LocatedTarget } from "./health.hosts";
import type { MergeActor } from "./merge-queue";

/** The name every adoption call and event carries. */
export const ADOPT_CAPABILITY = "adopt_steering_merges";

/** The proposal row Oxagen recorded for one pull request. */
export interface AdoptablePull {
  publicId: string;
  /** The head the proposal last recorded, which the host must have merged. */
  headSha: string | null;
  /** The person who opened the proposal, for the separation of duties. */
  createdById: string | null;
}

export interface AdoptDeps {
  now(): Date;
  locate(scope: HealthScope): Promise<LocatedTarget | null>;
  loadRow(scope: HealthScope): Promise<HealthRow | null>;
  /** The GitHub history target, or null when this deployment has no Oxagen GitHub App settings. */
  history(located: LocatedTarget): Promise<GithubHistoryTarget | null>;
  /** The proposal row this workspace holds for pull request `number` in `repository`, or null. */
  findPull(scope: AdoptScope, repository: string, number: number): Promise<AdoptablePull | null>;
  /** The governance mode the production branch declares. */
  mode(scope: AdoptScope): Promise<GovernanceMode>;
  roles(scope: AdoptScope, userId: string): Promise<Omit<MergeActor, "userId">>;
  /** Read the health again and act on it (`refreshRepoHealth`). */
  refresh(scope: HealthScope, trigger: HealthTrigger): Promise<HealthOutcome | null>;
  /** Publish the production branch as the next steering version. Answers its number, or null when nothing went live. */
  publish(scope: AdoptScope): Promise<number | null>;
  emit(event: SecurityEventInput): void;
}

export type AdoptScope = { orgId: string; workspaceId: string };

export interface AdoptInput {
  actorUserId: string | null;
  requestId: string | null;
}

export interface AdoptResult {
  health: RepoHealth;
  adopted: { commit: string; pullRequest: number }[];
  publishedVersion: number | null;
}

function refusal(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Adopt every host merge on main since the published commit, or refuse and
 * change nothing. See the header for what each merge must prove.
 */
export async function adoptHostMerges(
  scope: AdoptScope,
  input: AdoptInput,
  deps: AdoptDeps,
): Promise<AdoptResult> {
  const userId = input.actorUserId;
  if (!userId)
    throw new HandlerError({
      code: "forbidden",
      reason: "no_principal",
      message: "Adopting a host merge needs a signed-in person.",
    });
  const located = await deps.locate(scope);
  if (located === null)
    throw new HandlerError({
      code: "not_found",
      reason: "steering_repo_not_ready",
      message: "This workspace has no steering repo that is ready.",
    });
  const name = located.target.repository.full_name;
  if (located.target.provider !== "github")
    throw refusal(
      "adoption_unsupported",
      `${name} is on GitLab. Oxagen adopts host merges on GitHub only, so use Repair settings to put main back.`,
    );
  const row = await deps.loadRow(scope);
  if (row?.health !== "diverged")
    throw refusal(
      "nothing_to_adopt",
      `${name} reads ${row?.health ?? "unread"}, so it has no host merge to adopt.`,
    );
  const t = await deps.history(located);
  if (t === null)
    throw refusal(
      "steering_app_unconfigured",
      "This deployment has no Oxagen GitHub App settings, so it cannot read the steering repo.",
    );
  const published = await githubPublished(t);
  if (published === null)
    throw refusal(
      "steering_publication_missing",
      `Oxagen found no steering version its GitHub App published in ${name}, so it has nothing to adopt the merges onto.`,
    );
  const listed = await githubUnproven(t, published);
  if ("refused" in listed)
    throw refusal(
      "adoption_refused",
      `Oxagen cannot adopt the merges on ${name}: ${listed.refused}. Use Repair settings to put main back.`,
    );

  // Prove every commit before anything is written.
  const proven: { commit: string; pullRequest: number; pull: AdoptablePull }[] = [];
  for (const commit of listed.commits) {
    const merge = await githubHostMerge(t, commit);
    if (merge === null)
      throw refusal(
        "adoption_refused",
        `Commit ${short(commit.sha)} on main did not land through a pull request, so Oxagen cannot adopt it. Use Repair settings to put main back.`,
      );
    const pull = await deps.findPull(scope, name, merge.number);
    if (pull === null)
      throw refusal(
        "adoption_refused",
        `Pull request #${merge.number} was not opened by Oxagen, so Oxagen cannot adopt commit ${short(commit.sha)}. Use Repair settings to put main back.`,
      );
    if (pull.headSha !== merge.headSha)
      throw refusal(
        "adoption_refused",
        `Pull request #${merge.number} merged at ${short(merge.headSha)}, not at the head Oxagen opened it with, so Oxagen cannot adopt it.`,
      );
    if (!(await githubSameChanges(t, commit.sha, merge.number)))
      throw refusal(
        "adoption_refused",
        `Commit ${short(commit.sha)} changes other files than pull request #${merge.number}, so Oxagen cannot adopt it.`,
      );
    proven.push({ commit: commit.sha, pullRequest: merge.number, pull });
  }

  // The person must be one the governance mode lets merge each pull request.
  const mode = await deps.mode(scope);
  const actor: MergeActor = { userId, ...(await deps.roles(scope, userId)) };
  for (const { pullRequest, pull } of proven) {
    const refused = mergeRefusal(mode, actor, pull.createdById);
    if (refused !== null)
      throw new HandlerError({
        code: "forbidden",
        reason: refused,
        message: `Governance mode ${mode} does not let this person merge pull request #${pullRequest}, so they cannot adopt it (${refused}).`,
      });
  }

  // Record each adoption on its commit, read the health, and publish.
  const at = deps.now();
  for (const { commit, pullRequest } of proven)
    await githubRecordAdoption(
      t,
      commit,
      `Adopted in Oxagen by user ${userId} at ${at.toISOString()}, as the merge of pull request #${pullRequest}.`,
    );
  const outcome = await deps.refresh(scope, {
    reason: "adoption",
    actor: null,
    at: at.toISOString(),
    settings: [],
    pull_request: null,
  });
  const health = outcome?.health ?? "diverged";
  let publishedVersion: number | null = null;
  if (health === "healthy") {
    try {
      publishedVersion = await deps.publish(scope);
    } catch (err) {
      // The adoption stands. The repository sync publishes main next.
      logger.warn(
        { err, ...scope, repository: name },
        "steering-repo.adopt: the merges were adopted, but the publish failed; the repository sync publishes main next",
      );
    }
  }
  const adopted = proven.map(({ commit, pullRequest }) => ({ commit, pullRequest }));
  deps.emit({
    eventType: "steering.published",
    actorUserId: userId,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    capability: ADOPT_CAPABILITY,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: input.requestId,
    detail: { fullName: name, adopted, publishedVersion },
  });
  logger.info(
    { ...scope, repository: name, adopted, health, publishedVersion },
    "steering-repo.adopt: adopted the host merges on main",
  );
  return { health, adopted, publishedVersion };
}
