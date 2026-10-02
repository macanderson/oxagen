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
//   legacy source the code repository that still steers a workspace made
//                 before steering repos existed (#4875)
//   import run    the `steering_import` key of the same settings: the run
//                 that moves that repository's .oxagen/ tree, which can stop
//                 after the repository stopped steering (#5082)
//
// A workspace with no provisioning state answers `not_started` with every
// other provisioning field null. The health banner sits in the workspace
// layout and reads this on every page, so an error here would break every
// page of a workspace made before provisioning existed.
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  SteeringImportRunView,
  SteeringRepoDifference,
  SteeringRepoGetOutput,
  steeringRepoGet,
} from "@oxagen/oxagen/contracts/steering_repo.get";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import { and, eq } from "drizzle-orm";
import {
  readSteeringConnection,
  readSteeringRepoState,
  steeringConnectionChoiceOf,
  type SteeringConnection,
  type SteeringRepoState,
} from "./steering_repo.provision";
import {
  readImportState,
  type SteeringImportState,
} from "./steering-repo/import-run";
import {
  readLegacySteeringSource,
  type LegacySteeringSource,
} from "./steering-repo/legacy-source";
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
  /** The code repository that still steers the workspace, or null. */
  readLegacySource(
    scope: SteeringRepoReadScope,
  ): Promise<LegacySteeringSource | null>;
  /** The organization's stored steering connection, or null. */
  readConnection(scope: SteeringRepoReadScope): Promise<SteeringConnection | null>;
  /** The `steering_import` state in the workspace's settings, or null. */
  readImport(scope: SteeringRepoReadScope): Promise<SteeringImportState | null>;
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
  status: "not_started",
  step: null,
  failedStep: null,
  error: null,
  provider: null,
  repository: null,
  publishedVersion: null,
  health: null,
  differences: [],
  legacySource: null,
  connection: null,
  requestedName: null,
  connectionChoices: [],
  importRun: null,
};

/** A connection as the read names it. */
function connectionView(
  c: SteeringConnection,
): SteeringRepoGetOutput["connectionChoices"][number] {
  return steeringConnectionChoiceOf(c);
}

function legacySourceView(
  legacy: LegacySteeringSource | null,
): SteeringRepoGetOutput["legacySource"] {
  if (legacy === null) return null;
  const provider = legacy.provider === "gitlab" ? "gitlab" : "github";
  return {
    fullName: legacy.full_name,
    url: steeringRepoUrl(provider, legacy.full_name),
    provider,
  };
}

/**
 * The import run as the read names it. The source is a GitHub repository,
 * because the import reads `.oxagen/` only from GitHub.
 */
function importRunView(
  state: SteeringImportState | null,
): SteeringImportRunView | null {
  if (state === null) return null;
  return {
    status: state.status,
    step: state.step,
    source:
      state.source === null
        ? null
        : {
            fullName: state.source.full_name,
            url: steeringRepoUrl("github", state.source.full_name),
          },
    pullRequests: state.pull_requests.map((pr) => ({
      number: pr.number,
      url: pr.url,
      branch: pr.branch,
    })),
    cleanup: state.cleanup,
    error: state.error,
  };
}

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
    const [state, legacy, stored, imported] = await Promise.all([
      deps.readState(scope),
      deps.readLegacySource(scope),
      deps.readConnection(scope),
      deps.readImport(scope),
    ]);
    const legacySource = legacySourceView(legacy);
    // The connection the workspace chose comes before the organization's.
    const where = state?.connection ?? stored;
    const connection = where === null ? null : connectionView(where);
    const importRun = importRunView(imported);
    if (state === null)
      return { ...NO_STEERING_REPO, legacySource, connection, importRun };

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
      legacySource,
      connection,
      requestedName: state.requested_name,
      connectionChoices: state.connection_choices.map(connectionView),
      importRun,
    };
  };
}

/**
 * The workspace's settings, read once per call. The handler passes one scope
 * object to `readState` and `readImport`, and the health banner runs this read
 * on every workspace page, so the two share one query.
 */
const settingsReads = new WeakMap<SteeringRepoReadScope, Promise<unknown>>();

function workspaceSettings(scope: SteeringRepoReadScope): Promise<unknown> {
  let read = settingsReads.get(scope);
  if (read === undefined) {
    const w = schema.workspaces;
    read = withTenantDb((tx) =>
      tx
        .select({ settings: w.settings })
        .from(w)
        .where(and(eq(w.id, scope.workspaceId), eq(w.orgId, scope.orgId)))
        .limit(1),
    ).then(([row]) => (row === undefined ? null : row.settings));
    settingsReads.set(scope, read);
  }
  return read;
}

/** The production reads, inside the tenant scope the kernel entered. */
export const productionSteeringRepoReadDeps: SteeringRepoReadDeps = {
  async readState(scope) {
    const settings = await workspaceSettings(scope);
    return settings === null ? null : readSteeringRepoState(settings);
  },
  async readImport(scope) {
    return readImportState(await workspaceSettings(scope));
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
  readLegacySource: readLegacySteeringSource,
  async readConnection(scope) {
    const o = schema.organizations;
    // tenancy: filtered by the orgId the kernel scoped the read to. It reads
    // one key of the organization's own settings.
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ settings: o.settings })
        .from(o)
        .where(eq(o.id, scope.orgId))
        .limit(1),
    );
    return row === undefined ? null : readSteeringConnection(row.settings);
  },
};

export const getSteeringRepoHandler = createGetSteeringRepoHandler(
  productionSteeringRepoReadDeps,
);
