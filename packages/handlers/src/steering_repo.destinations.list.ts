// audit-exempt: read-only. The kernel's capability.invoke_* audit records the access.
//
// steering_repo.destinations.list.ts: list_steering_repo_destinations (#5196).
//
// Where a new workspace's steering repo can go, for the create forms to offer
// before `create_workspace` runs. The places come from the listing the
// provisioning job's pick_connection reads (`listGithubSteeringConnections`
// and `listGitlabSteeringConnections`), so a form never offers a place the job
// would refuse. A host that refuses the stored token is named in
// `reauthorize`, and its places are left out, so one lapsed token does not
// hide the other host's places.
import { schema, withTenantDb } from "@oxagen/database";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringRepoDestinationsList,
  type SteeringRepoDestinationsListOutput,
} from "@oxagen/oxagen/contracts/steering_repo.destinations.list";
import { defaultSteeringRepoName } from "@oxagen/oxagen/steering-repo/names";
import { eq } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import {
  listGithubSteeringConnections,
  listGitlabSteeringConnections,
  readSteeringConnection,
  steeringConnectionChoiceOf,
  steeringRepoProvisionDeps,
  type GithubSteeringClients,
  type GitlabSteeringClients,
  type SteeringConnection,
} from "./steering_repo.provision";

/** What the read needs outside the mapping. Tests pass their own. */
export interface SteeringRepoDestinationsDeps {
  /** The Oxagen GitHub App's clients, or null when it is not configured. */
  github(orgId: string, actorUserId: string): GithubSteeringClients | null;
  /** The organization's stored GitLab group tokens. */
  gitlab(orgId: string, actorUserId: string): GitlabSteeringClients;
  /** The organization's stored steering connection, or null. */
  readDefault(orgId: string): Promise<SteeringConnection | null>;
}

/**
 * The places one host offers, or null when the host refused the stored token.
 * Any other failure throws, because a form that silently offers nothing would
 * read as "nothing is connected".
 */
async function placesOn(
  host: "github" | "gitlab",
  orgId: string,
  list: () => Promise<SteeringConnection[]>,
): Promise<SteeringConnection[] | null> {
  try {
    return await list();
  } catch (err) {
    if (
      !(err instanceof gh.SteeringReauthorizeError) &&
      !(err instanceof gl.SteeringGitlabReauthorizeError)
    )
      throw err;
    logger.warn(
      { orgId, host, err: err.message },
      "list_steering_repo_destinations: the host refused the stored steering token",
    );
    return null;
  }
}

export function createListSteeringRepoDestinationsHandler(
  deps: SteeringRepoDestinationsDeps,
): CapabilityHandler<typeof steeringRepoDestinationsList> {
  return async (input, ctx): Promise<SteeringRepoDestinationsListOutput> => {
    // The kernel's IAM check allows every capability for a non-enterprise
    // org, so the handler asks for the contract's roles itself (INV-29).
    await assertContractRole(steeringRepoDestinationsList, ctx);
    const actorUserId = (await resolveActingUserId(ctx)) ?? "";

    const [github, gitlab, stored] = await Promise.all([
      placesOn("github", ctx.orgId, () =>
        listGithubSteeringConnections(deps.github(ctx.orgId, actorUserId)),
      ),
      placesOn("gitlab", ctx.orgId, () =>
        listGitlabSteeringConnections(deps.gitlab(ctx.orgId, actorUserId)),
      ),
      deps.readDefault(ctx.orgId),
    ]);

    const reauthorize: SteeringRepoDestinationsListOutput["reauthorize"] = [];
    if (github === null) reauthorize.push("github");
    if (gitlab === null) reauthorize.push("gitlab");

    return {
      destinations: [...(github ?? []), ...(gitlab ?? [])].map(
        steeringConnectionChoiceOf,
      ),
      default: stored === null ? null : steeringConnectionChoiceOf(stored),
      defaultName:
        input.slug === undefined ? null : defaultSteeringRepoName(input.slug),
      reauthorize,
    };
  };
}

/** The production reads: the provisioning job's own host clients. */
export const productionSteeringRepoDestinationsDeps: SteeringRepoDestinationsDeps =
  {
    github: (orgId, actorUserId) =>
      steeringRepoProvisionDeps({ actorUserId }).github({
        kind: "organization",
        orgId,
      }),
    gitlab: (orgId, actorUserId) =>
      steeringRepoProvisionDeps({ actorUserId }).gitlab({
        kind: "organization",
        orgId,
      }),
    async readDefault(orgId) {
      const o = schema.organizations;
      // tenancy: filtered by the orgId the kernel scoped the read to. It reads
      // one key of the organization's own settings.
      const [row] = await withTenantDb((tx) =>
        tx.select({ settings: o.settings }).from(o).where(eq(o.id, orgId)).limit(1),
      );
      return row === undefined ? null : readSteeringConnection(row.settings);
    },
  };

export const listSteeringRepoDestinationsHandler =
  createListSteeringRepoDestinationsHandler(
    productionSteeringRepoDestinationsDeps,
  );
