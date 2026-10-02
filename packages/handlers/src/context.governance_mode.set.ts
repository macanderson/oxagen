// context.governance_mode.set.ts: change the governance mode a workspace
// steers under, from Organization › Workspaces › Edit workspace (ADR-061).
//
// The mode is a file, not a column. ADR-061 decision 1 rejects a
// `workspace_settings.governance_mode` cache, so `open_steering_pr` and
// `merge_steering_pr` read the repository itself every time, and a write here
// is a change to that file. Which file depends on the layout:
//
//   steering  `steering/governance.toml`, the top-level `mode` key. Its
//             presence on the production branch marks a steering repository.
//             steering-repo/governance-mode.ts handles it (ADR-232).
//   legacy    `.oxagen/rules/governance.toml`, handled here.
//
// THE MODE IN FORCE DECIDES THE ROUTE. Loosening governance is the change a
// strict mode most needs to see coming, so the route is read off the file on
// the production branch rather than off what the caller asked for:
//
//   solo            The change lands at once. A review step here would guard
//                   nothing: solo already lets one person publish alone.
//   team/regulated  The change waits on a pull request for review.
//
// In a legacy repository, landing at once is a commit to the production
// branch, and the pull request is an ordinary one a person merges on GitHub.
// A legacy file that does not parse takes the review route, because a mode
// nobody can establish must not be treated as `solo`.
//
// In a steering repository nothing commits to the production branch. Both
// routes open a steering PR from `steering/governance`, and landing at once
// merges it through the steering merge queue. A steering file that does not
// parse refuses the call, because the merge queue refuses every steering PR
// until it parses.
//
// The steering review route records its PR as a governance proposal (kind
// and lineage `governance`) and answers `proposed`. The mode in force stays
// as it is until `merge_steering_pr` lands the PR for an approver, with the
// approver on the record (#4795). A call that proposes a change replaces the
// governance proposal already open, because the PR it reuses now carries this
// call's change. The prior proposal is set aside in the same transaction that
// records its replacement, so a failed write never leaves the PR without one.
// A call that lands at once, or that picks the mode already in force, sets
// the open proposal aside, because nothing is waiting for review any more.
// Apply now is not that land path. In team or regulated it is an override,
// and it is recorded as one (ADR-232).
//
// `applyImmediately` takes the review route back to landing at once. It is
// not privilege escalation: the contract admits only org Owner/Admin and
// workspace Owner/Admin, so every caller who can reach this capability can
// already commit the same file on GitHub by hand. The override leaves
// `steering.governance_overridden` behind, which a commit by hand does not.
// That record is the point.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import {
  contextGovernanceModeSet,
  GOVERNANCE_BRANCH,
  GOVERNANCE_FILE,
  STEERING_GOVERNANCE_BRANCH,
  STEERING_GOVERNANCE_FILE,
} from "@oxagen/oxagen/contracts/context.governance_mode.set";
import {
  draftGovernanceToml,
  GOVERNANCE_LINEAGE,
  type GovernanceMode,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import {
  githubRefused,
  type SteeringRepository,
} from "./context.steering.github";
import { parseGovernanceMode } from "./context.steering.policy";
import {
  claimCutoff,
  mergeClaimed,
  mergeInProgress,
  type ProposalRow,
} from "./context.steering.store";
import { logger } from "./logger";
import {
  productionSteeringGovernanceSeams,
  readSteeringGovernance,
  rewriteGovernanceMode,
  setSteeringGovernanceMode,
  type SteeringGovernanceSeams,
} from "./steering-repo/governance-mode";

/**
 * The pull request's title and body never name a mode.
 *
 * `SteeringGitHub` has no `updatePullRequest`, so a pull request reused for a
 * second proposal keeps the title and body it was opened with. Naming the
 * mode there would leave a pull request whose title says `regulated` carrying
 * a branch that sets `solo` — a review artefact that contradicts the change it
 * is reviewing, which is worse than one that says less. The diff is the
 * statement, and the diff is always current.
 */
const PR_TITLE = "Change the steering governance mode";

const PR_BODY = [
  "This pull request changes `.oxagen/rules/governance.toml`, which decides",
  "who may merge a steering PR in this workspace.",
  "",
  "**Read the diff for the mode being set** — this description is not updated",
  "when the branch is, so the file is the only current statement of it.",
  "",
  "| Mode | Who merges a steering PR |",
  "| --- | --- |",
  "| `solo` | any workspace member, the author included |",
  "| `team` | an org Owner or Admin, or a workspace Owner or Admin, other than the author |",
  "| `regulated` | an org Owner or Admin other than the author, recorded as the accountable approver |",
  "",
  "Merging this is an ordinary merge on GitHub. Oxagen runs no checks on this",
  "pull request and does not merge it.",
].join("\n");

/** The target workspace, resolved the way `update_workspace_settings` resolves it. */
async function resolveTargetWorkspace(
  ctx: { orgId: string; workspaceId: string },
  workspaceId: string | undefined,
): Promise<{ id: string; name: string }> {
  // `workspace.workspaces` is org_only, so this reads correctly under the
  // org-only scope the Organization › Workspaces section runs in (ADR-068).
  const target = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: workspaceId
        ? and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.publicId, workspaceId),
          )
        : and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.id, ctx.workspaceId),
          ),
      columns: { id: true, name: true, archivedAt: true },
    }),
  );
  if (!target) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
    });
  }
  if (target.archivedAt !== null) {
    // Same rule `update_workspace_settings` applies: an archived workspace is
    // a record, not something whose settings are edited. Its agents are gone,
    // so there is nothing left for a governance mode to steer.
    throw new HandlerError({
      code: "conflict",
      reason: "workspace_archived",
      message: `${target.name} was archived on ${target.archivedAt.toISOString()}; an archived workspace's governance mode cannot be changed`,
    });
  }
  return { id: target.id, name: target.name };
}

/**
 * Record a mode that landed. Both events when the caller overrode review, not
 * one or the other: "every governance change" and "every skipped review" are
 * each a single event-type filter this way, and neither answer is quietly
 * missing rows.
 */
function emitChanged(
  deps: SteeringDeps,
  ctx: { orgId: string; requestId?: string | null },
  actingUserId: string,
  workspaceId: string,
  detail: {
    fullName: string;
    productionBranch: string;
    previousMode: GovernanceMode | null;
    mode: GovernanceMode;
    commitSha: string;
    overrodeReview: boolean;
  },
): void {
  const base = {
    actorUserId: actingUserId,
    orgId: ctx.orgId,
    workspaceId,
    capability: contextGovernanceModeSet.name,
    outcome: "success" as const,
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail,
  };
  deps.emit({ ...base, eventType: "steering.governance_changed" });
  if (detail.overrodeReview) {
    deps.emit({ ...base, eventType: "steering.governance_overridden" });
  }
}

/** No proposal has this id, so a lineage lookup excludes nothing. */
const NO_PROPOSAL = "00000000-0000-0000-0000-000000000000";

/** The statuses a proposal with an open PR holds. */
const OPEN_PR = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

/**
 * The governance proposal open in the workspace, if any (#4795). A record
 * proposal on the lineage refuses the call, and so does a merge that has
 * claimed the proposal. Nothing is written: the caller sets the proposal aside
 * once the change that replaces it is recorded.
 */
async function openGovernanceProposal(
  deps: SteeringDeps,
  scope: { orgId: string; workspaceId: string },
): Promise<ProposalRow | null> {
  const open = await deps.store.findOpenPrOnLineage(
    scope,
    GOVERNANCE_LINEAGE,
    NO_PROPOSAL,
  );
  if (!open) return null;
  if (open.kind !== "governance") {
    throw new HandlerError({
      code: "conflict",
      reason: "lineage_taken",
      message: `${open.publicId} is an open record proposal on the lineage ${GOVERNANCE_LINEAGE}, which governance changes use. Dismiss it, then set the mode again.`,
    });
  }
  if (mergeClaimed(open, deps.now())) {
    throw mergeInProgress(open.publicId, open.mergeClaimedAt);
  }
  return open;
}

/** The write that sets an open governance proposal aside. */
function setAside(
  deps: SteeringDeps,
  open: ProposalRow,
  reason: string,
  actingUserId: string,
) {
  const now = deps.now();
  return {
    id: open.id,
    patch: {
      status: "rejected" as const,
      dismissedAt: now,
      dismissedReason: reason,
      updatedById: actingUserId,
    },
    from: OPEN_PR,
    guard: { noClaimSince: claimCutoff(now) },
  };
}

/**
 * The person picked the mode already in force, so a change still waiting for
 * review no longer stands (#4795). Its proposal is set aside and its PR closed,
 * or a reviewer could still land a mode nobody wants now. A record proposal on
 * the lineage is not this call's to touch.
 */
async function withdrawGovernanceProposal(
  deps: SteeringDeps,
  scope: { orgId: string; workspaceId: string },
  repo: SteeringRepository,
  actingUserId: string,
): Promise<void> {
  const open = await deps.store.findOpenPrOnLineage(
    scope,
    GOVERNANCE_LINEAGE,
    NO_PROPOSAL,
  );
  if (!open || open.kind !== "governance") return;
  if (mergeClaimed(open, deps.now())) {
    throw mergeInProgress(open.publicId, open.mergeClaimedAt);
  }
  const aside = setAside(
    deps,
    open,
    "Withdrawn: the mode it proposed was set back to the mode in force",
    actingUserId,
  );
  await deps.store.updateProposal(aside.id, aside.patch, aside.from, aside.guard);
  if (open.prNumber === null) return;
  // Best effort, as dismiss_proposal's close is: the row already says the
  // change is withdrawn, so Oxagen refuses to merge it.
  try {
    await deps.github.closePullRequest(repo, open.prNumber);
    await deps.github.deleteBranch(repo, STEERING_GOVERNANCE_BRANCH);
  } catch (err) {
    logger.warn(
      { err, proposal: open.publicId, pr: open.prNumber },
      "context.governance_mode.set: could not close a withdrawn governance PR",
    );
  }
}

/**
 * Record the review-route PR as a governance proposal, so merge_steering_pr
 * lands it for an approver (#4795). It carries no record: `force` is `info`,
 * the scope is the workspace, and the statement names the change. Its checks
 * are the steering checks reported on the PR, so the row lists none of the
 * six record checks.
 */
async function recordGovernanceProposal(
  deps: SteeringDeps,
  input: {
    scope: { orgId: string; workspaceId: string };
    repo: SteeringRepository;
    actingUserId: string;
    currentMode: GovernanceMode;
    mode: GovernanceMode;
    pullRequest: { number: number; htmlUrl: string };
    head: string;
    checksPassed: boolean;
    /** The governance proposal the reused PR carried until now. */
    replaces: ProposalRow | null;
  },
): Promise<ProposalRow> {
  const values = {
    orgId: input.scope.orgId,
    workspaceId: input.scope.workspaceId,
    lineageId: GOVERNANCE_LINEAGE,
    kind: "governance",
    force: "info",
    constraintEffect: null,
    sharingScope: "workspace",
    statement: `Change the steering governance mode from ${input.currentMode} to ${input.mode}.`,
    rationale: `Requested in the workspace's governance settings. ${STEERING_GOVERNANCE_FILE} on ${STEERING_GOVERNANCE_BRANCH} carries the change, and it lands after a workspace member other than the author approves it.`,
    source: `user:${input.actingUserId}`,
    supportRuns: [],
    supportAgents: [],
    supportingRecordIds: [],
    evidenceLinks: [],
    createdById: input.actingUserId,
    status: input.checksPassed ? "checks_passed" : "checks_failed",
    governanceMode: input.currentMode,
    provider: input.repo.provider,
    repository: input.repo.fullName,
    baseRef: input.repo.defaultBranch,
    branch: STEERING_GOVERNANCE_BRANCH,
    path: STEERING_GOVERNANCE_FILE,
    prNumber: input.pullRequest.number,
    prUrl: input.pullRequest.htmlUrl,
    headSha: input.head,
    checks: [],
  } satisfies Parameters<SteeringDeps["store"]["insertProposal"]>[0];
  if (input.replaces === null) return deps.store.insertProposal(values);
  return deps.store.replaceProposal(
    setAside(
      deps,
      input.replaces,
      "Replaced by a newer governance change on the same pull request",
      input.actingUserId,
    ),
    values,
  );
}

export function makeSetGovernanceModeHandler(
  deps: SteeringDeps,
  seams: SteeringGovernanceSeams = productionSteeringGovernanceSeams,
): CapabilityHandler<typeof contextGovernanceModeSet> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    // Identical to `update_workspace_settings`, and deliberately so: this is
    // edited from the same dialog. With a `workspaceId` the gate is org-level
    // only, because `assertOrgRole` reads the workspace role on
    // `ctx.workspaceId` and a role in one workspace must not reach another.
    // `namedRolesOnly` keeps the workspace Owner and Admin rule off it too
    // (#5228).
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      input.workspaceId === undefined
        ? { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] }
        : { org: ["Owner", "Admin"], namedRolesOnly: true },
    );
    // assertOrgRole refuses a call with no acting user, so this never throws.
    // It narrows the type: the ledger and the events name a person.
    if (actingUserId === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message: "No signed-in user on the request",
      });
    }

    const target = await resolveTargetWorkspace(ctx, input.workspaceId);
    const scope = { orgId: ctx.orgId, workspaceId: target.id };

    return runInTenantScope(
      { ...getPrincipalAttribution(), ...scope },
      async () => {
        const repo: SteeringRepository =
          await deps.github.resolveRepository(scope);

        // The layout is read, not declared: `steering/governance.toml` on the
        // production branch marks a steering repository, as it does for the
        // merge queue. Everything after this read happens at one commit.
        const productionHead = await deps.github.branchHead(
          repo,
          repo.defaultBranch,
        );
        if (productionHead === null) {
          throw new HandlerError({
            code: "conflict",
            reason: "production_branch_missing",
            message: `${repo.fullName} has no ${repo.defaultBranch} branch. Create it, then set the mode again.`,
          });
        }
        const steeringText = await deps.github.readFile(
          repo,
          STEERING_GOVERNANCE_FILE,
          productionHead,
        );
        if (steeringText !== null) {
          const currentMode = readSteeringGovernance(steeringText).mode;
          const answer = {
            requestedMode: input.mode,
            previousMode: currentMode,
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            path: STEERING_GOVERNANCE_FILE,
          };
          if (currentMode === input.mode) {
            await withdrawGovernanceProposal(deps, scope, repo, actingUserId);
            return {
              ...answer,
              outcome: "unchanged" as const,
              effectiveMode: input.mode,
              commitSha: null,
              pullRequest: null,
              overrodeReview: false,
              proposalId: null,
            };
          }
          const wantsReview = currentMode !== "solo";
          const overrodeReview = wantsReview && input.applyImmediately;
          // A mode the rest of the file does not allow refuses here, before
          // an open proposal is set aside.
          rewriteGovernanceMode(steeringText, input.mode);
          // Read only: the open proposal stays until its replacement is
          // recorded, so a push or a check that fails leaves it standing.
          const prior = await openGovernanceProposal(deps, scope);
          const result = await setSteeringGovernanceMode({
            host: deps.github,
            repo,
            scope,
            productionHead,
            currentText: steeringText,
            currentMode,
            mode: input.mode,
            land: !wantsReview || overrodeReview,
            withoutReview: overrodeReview,
            actingUserId,
            now: deps.now,
            seams,
          });
          if (result.outcome === "proposed") {
            const proposal = await recordGovernanceProposal(deps, {
              scope,
              repo,
              actingUserId,
              currentMode,
              mode: input.mode,
              pullRequest: result.pullRequest,
              head: result.head,
              checksPassed: result.checksPassed,
              replaces: prior,
            });
            logger.info(
              {
                orgId: ctx.orgId,
                workspaceId: target.id,
                repository: repo.fullName,
                previousMode: currentMode,
                requestedMode: input.mode,
                pr: result.pullRequest.htmlUrl,
                reused: result.pullRequest.reused,
                proposalId: proposal.publicId,
                checksPassed: result.checksPassed,
              },
              "context.governance_mode.set: proposed governance mode",
            );
            return {
              ...answer,
              outcome: "proposed" as const,
              effectiveMode: currentMode,
              commitSha: null,
              pullRequest: result.pullRequest,
              overrodeReview: false,
              proposalId: proposal.publicId,
            };
          }
          // The change landed on the PR the open proposal named, so nothing
          // waits for review now.
          if (prior !== null) {
            const aside = setAside(
              deps,
              prior,
              "Replaced by a governance change that landed at once",
              actingUserId,
            );
            await deps.store
              .updateProposal(aside.id, aside.patch, aside.from, aside.guard)
              .catch((err: unknown) =>
                logger.warn(
                  { err, proposal: prior.publicId },
                  "context.governance_mode.set: could not set aside the governance proposal a landed change replaced",
                ),
              );
          }
          emitChanged(deps, ctx, actingUserId, target.id, {
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            previousMode: currentMode,
            mode: input.mode,
            commitSha: result.commitSha,
            overrodeReview,
          });
          logger.info(
            {
              orgId: ctx.orgId,
              workspaceId: target.id,
              repository: repo.fullName,
              previousMode: currentMode,
              mode: input.mode,
              commit: result.commitSha,
              pr: result.pullRequest.htmlUrl,
              version: result.version,
              deploymentUrl: result.deploymentUrl,
              overrodeReview,
            },
            "context.governance_mode.set: merged governance mode",
          );
          return {
            ...answer,
            outcome: "applied" as const,
            effectiveMode: input.mode,
            commitSha: result.commitSha,
            pullRequest: result.pullRequest,
            overrodeReview,
            proposalId: null,
          };
        }

        const existing = await deps.github.readFile(
          repo,
          GOVERNANCE_FILE,
          repo.defaultBranch,
        );
        const parsed = parseGovernanceMode(existing);
        const unreadable = typeof parsed === "object";
        // `parseGovernanceMode` answers the DEFAULT for an absent file, which
        // is the right answer for "what mode is in force" and the wrong one
        // for "what did the repository say". `previousMode` is the second
        // question, so an absent or unparseable file is null here rather than
        // `team`: an audit row must never claim the repository said something
        // it never said.
        const previousMode: GovernanceMode | null =
          existing === null || unreadable ? null : (parsed as GovernanceMode);
        // What is in force right now, which is what decides the route. Null
        // when the file cannot be parsed — nothing is established, so the
        // strict route applies.
        const currentMode: GovernanceMode | null = unreadable
          ? null
          : (parsed as GovernanceMode);

        if (previousMode === input.mode) {
          // The file already says it. Committing an identical file would make
          // an empty commit and a pull request with no diff.
          return {
            outcome: "unchanged" as const,
            requestedMode: input.mode,
            previousMode,
            effectiveMode: input.mode,
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            path: GOVERNANCE_FILE,
            commitSha: null,
            pullRequest: null,
            overrodeReview: false,
            proposalId: null,
          };
        }

        const wantsReview = currentMode !== "solo";
        const overrodeReview = wantsReview && input.applyImmediately;
        const content = draftGovernanceToml(input.mode);

        if (!wantsReview || overrodeReview) {
          let commitSha: string;
          try {
            ({ commitSha } = await deps.github.putFile(repo, {
              path: GOVERNANCE_FILE,
              content,
              message: `Set steering governance mode to ${input.mode}`,
              branch: repo.defaultBranch,
            }));
          } catch (err) {
            throw githubRefused(err);
          }

          emitChanged(deps, ctx, actingUserId, target.id, {
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            previousMode,
            mode: input.mode,
            commitSha,
            overrodeReview,
          });

          logger.info(
            {
              orgId: ctx.orgId,
              workspaceId: target.id,
              repository: repo.fullName,
              previousMode,
              mode: input.mode,
              commit: commitSha,
              overrodeReview,
            },
            "context.governance_mode.set: committed governance mode",
          );

          return {
            outcome: "applied" as const,
            requestedMode: input.mode,
            previousMode,
            effectiveMode: input.mode,
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            path: GOVERNANCE_FILE,
            commitSha,
            pullRequest: null,
            overrodeReview,
            proposalId: null,
          };
        }

        let pullRequest: {
          number: number;
          htmlUrl: string;
          reused: boolean;
        };
        try {
          await deps.github.ensureBranch(
            repo,
            GOVERNANCE_BRANCH,
            repo.defaultBranch,
          );
          await deps.github.putFile(repo, {
            path: GOVERNANCE_FILE,
            content,
            message: `Set steering governance mode to ${input.mode}`,
            branch: GOVERNANCE_BRANCH,
          });
          // The branch is pushed BEFORE the pull request is looked for, so a
          // reused pull request always carries this change rather than the
          // previous one.
          const open = await deps.github.findOpenPullRequest(repo, {
            head: GOVERNANCE_BRANCH,
            base: repo.defaultBranch,
          });
          pullRequest = open
            ? { number: open.number, htmlUrl: open.htmlUrl, reused: true }
            : {
                ...(await deps.github.openPullRequest(repo, {
                  title: PR_TITLE,
                  head: GOVERNANCE_BRANCH,
                  base: repo.defaultBranch,
                  body: PR_BODY,
                  labels: OXAGEN_PR_LABELS,
                })),
                reused: false,
              };
        } catch (err) {
          throw githubRefused(err);
        }

        logger.info(
          {
            orgId: ctx.orgId,
            workspaceId: target.id,
            repository: repo.fullName,
            previousMode,
            requestedMode: input.mode,
            pr: pullRequest.htmlUrl,
            reused: pullRequest.reused,
          },
          "context.governance_mode.set: proposed governance mode",
        );

        return {
          outcome: "proposed" as const,
          requestedMode: input.mode,
          previousMode,
          // Nothing moved: the mode in force is still whatever the production
          // branch says, and null when that cannot be read.
          effectiveMode: currentMode,
          fullName: repo.fullName,
          productionBranch: repo.defaultBranch,
          path: GOVERNANCE_FILE,
          commitSha: null,
          pullRequest,
          overrodeReview: false,
          proposalId: null,
        };
      },
    );
  };
}

export const setGovernanceModeHandler = makeSetGovernanceModeHandler(
  steeringDeps(),
  productionSteeringGovernanceSeams,
);
