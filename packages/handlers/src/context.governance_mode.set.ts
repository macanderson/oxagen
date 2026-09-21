// context.governance_mode.set.ts — change the governance mode a workspace
// steers under, from Organization › Workspaces › Edit workspace (ADR-061).
//
// The mode is a file, not a column: `.oxagen/rules/governance.toml` on the
// production branch of the workspace's main repository. ADR-061 decision 1
// rejects a `workspace_settings.governance_mode` cache precisely so that
// `open_context_pr` and `merge_context_pr` read the repository itself every
// time, which means a write here is a commit and nothing else would do.
//
// THE MODE IN FORCE DECIDES THE ROUTE. Loosening governance is the change a
// strict mode most needs to see coming, so the route is read off the file on
// the production branch rather than off what the caller asked for:
//
//   solo            → commit to the production branch. A review step here
//                     would guard nothing: solo already lets one person
//                     publish steering alone.
//   team/regulated  → commit to `oxagen/governance` and open a pull request
//                     against the production branch, for a person to merge on
//                     GitHub. An ORDINARY pull request — Oxagen runs no checks
//                     on it and `merge_context_pr` does not merge it.
//   unreadable      → the strict route. A governance.toml that does not parse
//                     already refuses every Context PR open and merge; a mode
//                     nobody can establish must not be treated as `solo`.
//
// `applyImmediately` takes the strict route back to the direct one. It is not
// privilege escalation: the contract admits only org Owner/Admin and
// workspace Owner/Admin, so every caller who can reach this capability can
// already commit the same file on GitHub by hand. The override is a
// convenience over doing it by hand — and, unlike doing it by hand, it leaves
// `steering.governance_overridden` behind. That record is the whole point.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  contextGovernanceModeSet,
  GOVERNANCE_BRANCH,
  GOVERNANCE_FILE,
} from "@oxagen/oxagen/contracts/context.governance_mode.set";
import {
  draftGovernanceToml,
  type GovernanceMode,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import type { SteeringRepository } from "./context.steering.github";
import { parseGovernanceMode } from "./context.steering.policy";
import { logger } from "./logger";

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
  "who may merge a Context PR in this workspace.",
  "",
  "**Read the diff for the mode being set** — this description is not updated",
  "when the branch is, so the file is the only current statement of it.",
  "",
  "| Mode | Who merges a Context PR |",
  "| --- | --- |",
  "| `solo` | any workspace member, the author included |",
  "| `team` | an org Owner or Admin, or a workspace Owner, other than the author |",
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

/** Wrap a GitHub refusal as `conflict: github_refused` with GitHub's own message. */
function githubRefused(err: unknown): HandlerError {
  if (err instanceof HandlerError) return err;
  return new HandlerError({
    code: "conflict",
    reason: "github_refused",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function makeSetGovernanceModeHandler(
  deps: SteeringDeps,
): CapabilityHandler<typeof contextGovernanceModeSet> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    // Identical to `update_workspace_settings`, and deliberately so: this is
    // edited from the same dialog. With a `workspaceId` the gate is org-level
    // only, because `assertOrgRole` reads the workspace role on
    // `ctx.workspaceId` and a role in one workspace must not reach another.
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      input.workspaceId === undefined
        ? { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] }
        : { org: ["Owner", "Admin"] },
    );

    const target = await resolveTargetWorkspace(ctx, input.workspaceId);
    const scope = { orgId: ctx.orgId, workspaceId: target.id };

    return runInTenantScope(
      { ...getPrincipalAttribution(), ...scope },
      async () => {
        const repo: SteeringRepository =
          await deps.github.resolveRepository(scope);

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
            commitSha: null,
            pullRequest: null,
            overrodeReview: false,
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

          const detail = {
            fullName: repo.fullName,
            productionBranch: repo.defaultBranch,
            previousMode,
            mode: input.mode,
            commitSha,
            overrodeReview,
          };
          const base = {
            actorUserId: actingUserId,
            orgId: ctx.orgId,
            workspaceId: target.id,
            capability: contextGovernanceModeSet.name,
            outcome: "success" as const,
            ip: null,
            userAgent: null,
            requestId: ctx.requestId ?? null,
            detail,
          };
          // Both events, not one or the other. "Every governance change" and
          // "every skipped review" are each a single event-type filter this
          // way, and neither answer is quietly missing rows.
          deps.emit({ ...base, eventType: "steering.governance_changed" });
          if (overrodeReview) {
            deps.emit({ ...base, eventType: "steering.governance_overridden" });
          }

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
            commitSha,
            pullRequest: null,
            overrodeReview,
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
          commitSha: null,
          pullRequest,
          overrodeReview: false,
        };
      },
    );
  };
}

export const setGovernanceModeHandler = makeSetGovernanceModeHandler(
  steeringDeps(),
);
