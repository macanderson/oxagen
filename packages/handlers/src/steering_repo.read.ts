// audit-exempt: read-only. The kernel's capability.invoke_* audit records the access.
//
// steering_repo.read.ts: get_steering_repo (steering-repo-spec, Provisioning
// and Settings drift; lane S2, #4560).
//
// The workspace's steering repo as the Repositories card, the health banner,
// and onboarding show it. Three records make the answer:
//
//   provisioning  the `steering_repo` key of the workspace's settings (S1)
//   version       the steering publication of that repository (S3), or
//                 version 1 once provisioning recorded it
//   health        the last health read and the settings it found different
//
// A workspace with no provisioning state answers `provisioning` with every
// other field null. The health banner sits in the workspace layout and reads
// this on every page, so an error here would break every page of a workspace
// made before provisioning existed.
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  SteeringRepoDifference,
  SteeringRepoGetOutput,
  steeringRepoGet,
} from "@oxagen/oxagen/contracts/steering_repo.get";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import { and, eq } from "drizzle-orm";
import {
  readSteeringRepoState,
  type SteeringRepoState,
} from "./steering_repo.provision";
import {
  displaySettingValue,
  readRepoHealthDetail,
  type RepoHealthDetail,
} from "./steering-repo/health";

/**
 * The version provisioning records as a deployment in its `publish_version`
 * step (`FIRST_VERSION` in ./steering_repo.provision). In a workspace,
 * `bind_repository` then publishes the first commit through the version store
 * as the same version 1 (#4732). Until a publication exists (an
 * organization's repository, which has no bind step, or the steps between
 * the two), this is the version the repository serves.
 */
export const PROVISIONED_VERSION = 1;

export interface SteeringRepoReadScope {
  orgId: string;
  workspaceId: string;
}

/** What the read needs outside the mapping. Tests pass their own. */
export interface SteeringRepoReadDeps {
  /** The `steering_repo` state in the workspace's settings, or null. */
  readState(scope: SteeringRepoReadScope): Promise<SteeringRepoState | null>;
  /** The published version of one repository, or null when none is recorded. */
  readPublishedVersion(
    scope: SteeringRepoReadScope,
    repository: string,
  ): Promise<number | null>;
  /** The last health read, or null before the first. */
  readHealth(scope: SteeringRepoReadScope): Promise<RepoHealthDetail | null>;
}

/**
 * The key S3's version store files a steering repo's publications under,
 * such as `github.com/acme/oxagen-platform`. It matches
 * `steeringRepositoryKey` in ./steering-repo/publisher.
 */
export function steeringRepoPublicationKey(
  provider: "github" | "gitlab",
  fullName: string,
): string {
  const cut = fullName.lastIndexOf("/");
  return repoRef(
    provider === "gitlab" ? "gitlab.com" : "github.com",
    fullName.slice(0, cut),
    fullName.slice(cut + 1),
  );
}

/** The repository's page on its host. */
export function steeringRepoUrl(
  provider: "github" | "gitlab",
  fullName: string,
): string {
  return `https://${provider === "gitlab" ? "gitlab.com" : "github.com"}/${fullName}`;
}

/** The answer for a workspace with no provisioning state. */
export const NO_STEERING_REPO: SteeringRepoGetOutput = {
  status: "provisioning",
  step: null,
  failedStep: null,
  error: null,
  provider: null,
  repository: null,
  publishedVersion: null,
  health: null,
  differences: [],
};

function workspaceScope(ctx: {
  orgId: string;
  workspaceId: string | null;
}): SteeringRepoReadScope {
  if (!ctx.workspaceId)
    throw new Error("[get_steering_repo] workspaceId is required (scoped capability)");
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

export function createGetSteeringRepoHandler(
  deps: SteeringRepoReadDeps,
): CapabilityHandler<typeof steeringRepoGet> {
  return async (_input, ctx): Promise<SteeringRepoGetOutput> => {
    const scope = workspaceScope(ctx);
    const state = await deps.readState(scope);
    if (state === null) return NO_STEERING_REPO;

    const provider = state.provider;
    const repository =
      provider !== null && state.repository !== null
        ? {
            fullName: state.repository.full_name,
            url: steeringRepoUrl(provider, state.repository.full_name),
          }
        : null;

    const [published, detail] = await Promise.all([
      provider !== null && repository !== null
        ? deps.readPublishedVersion(
            scope,
            steeringRepoPublicationKey(provider, repository.fullName),
          )
        : Promise.resolve(null),
      deps.readHealth(scope),
    ]);

    const differences: SteeringRepoDifference[] = (detail?.differences ?? []).map(
      (d) => ({
        setting: d.setting,
        expected: displaySettingValue(d.expected),
        actual: displaySettingValue(d.actual),
        changedBy: d.changed_by,
        changedAt: d.changed_at,
      }),
    );

    return {
      status: state.status,
      step: state.step,
      failedStep: state.failed_step,
      error: state.error,
      provider,
      repository,
      publishedVersion:
        published ?? (state.deployment_id !== null ? PROVISIONED_VERSION : null),
      health: detail?.health ?? null,
      differences,
    };
  };
}

/** The production reads, inside the tenant scope the kernel entered. */
export const productionSteeringRepoReadDeps: SteeringRepoReadDeps = {
  async readState(scope) {
    const w = schema.workspaces;
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ settings: w.settings })
        .from(w)
        .where(and(eq(w.id, scope.workspaceId), eq(w.orgId, scope.orgId)))
        .limit(1),
    );
    return row === undefined ? null : readSteeringRepoState(row.settings);
  },
  async readPublishedVersion(scope, repository) {
    const p = schema.steeringPublications;
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ version: p.publishedVersion })
        .from(p)
        .where(
          and(
            eq(p.orgId, scope.orgId),
            eq(p.workspaceId, scope.workspaceId),
            eq(p.repository, repository),
          ),
        )
        .limit(1),
    );
    return row?.version ?? null;
  },
  readHealth: readRepoHealthDetail,
};

export const getSteeringRepoHandler = createGetSteeringRepoHandler(
  productionSteeringRepoReadDeps,
);
