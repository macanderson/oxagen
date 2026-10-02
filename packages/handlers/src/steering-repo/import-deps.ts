// import-deps.ts: the production dependencies of import_workspace_steering
// (import-run.ts). The run itself touches no database and no host; this file
// is the one place that does.
//
// Every query runs inside the kernel's tenant scope and filters on the
// caller's orgId and workspaceId, which the kernel checked before the handler
// ran and assertContractRole narrowed to a workspace owner.
import { schema, withTenantDb } from "@oxagen/database";
import { createGitHubClient } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createSteeringGitHub } from "../context.steering.github";
import { createSteeringHost } from "../context.steering.host";
import { resolveGitHubToken } from "../lib/github-token";
import {
  GITHUB_STEERING_PROVIDER,
  GITLAB_STEERING_PROVIDER,
} from "../lib/steering-app";
import { workspaceRepositoriesLock } from "../repository.binding-write";
import {
  provisionSteeringRepo,
  readSteeringRepoState,
  SteeringProvisionBlockedError,
  steeringRepoProvisionDeps,
} from "../steering_repo.provision";
import {
  readImportState,
  STEERING_IMPORT_SETTING,
  type ImportScope,
  type SteeringHeadRead,
  type SteeringImportDeps,
  type SteeringImportState,
} from "./import-run";

/** Statuses that mean a connection is on its way out, as the steering seam reads them. */
const RETIRED_CONNECTION_STATUSES = new Set(["deleting", "deleted"]);

/**
 * How long a provisioning run that has not saved still counts as running. The
 * durable job saves after every step, so a quiet state this old stopped.
 */
const PROVISION_QUIET_MS = 10 * 60 * 1000;

function settingsPatch(state: SteeringImportState) {
  const column = schema.workspaces.settings;
  return sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END || ${JSON.stringify({ [STEERING_IMPORT_SETTING]: state })}::jsonb`;
}

function workspaceRow(scope: ImportScope) {
  return and(
    eq(schema.workspaces.id, scope.workspaceId),
    eq(schema.workspaces.orgId, scope.orgId),
  );
}

async function readSettings(scope: ImportScope): Promise<unknown> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(workspaceRow(scope))
      .limit(1),
  );
  if (!row)
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
      message: `Workspace ${scope.workspaceId} is not in this organization.`,
    });
  return row.settings;
}

/** The workspace's steering head, told apart into the cases the run needs. */
async function readSteeringHead(scope: ImportScope): Promise<SteeringHeadRead> {
  return withTenantDb(async (tx) => {
    const [head] = await tx
      .select({
        id: schema.repositoryBindingHeads.id,
        connectionId: schema.repositoryBindingHeads.connectionId,
        provider: schema.repositoryBindingHeads.provider,
        owner: schema.repositoryBindings.providerOwner,
        name: schema.repositoryBindings.providerName,
        fullName: schema.repositoryBindings.providerFullName,
        defaultBranch: schema.repositoryBindings.configuredDefaultRef,
        connectorId: schema.sourceConnections.connectorId,
        status: schema.sourceConnections.status,
        deletedAt: schema.sourceConnections.deletedAt,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .leftJoin(
        schema.sourceConnections,
        eq(
          schema.sourceConnections.id,
          schema.repositoryBindingHeads.connectionId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
        ),
      )
      .limit(1);

    if (head) {
      if (
        head.connectorId === GITHUB_STEERING_PROVIDER ||
        head.connectorId === GITLAB_STEERING_PROVIDER
      )
        return { kind: "provisioned", fullName: head.fullName };
      if (head.provider !== "github")
        return {
          kind: "unsupported",
          provider: head.provider,
          fullName: head.fullName,
        };
      if (
        head.connectorId === null ||
        head.deletedAt !== null ||
        RETIRED_CONNECTION_STATUSES.has(head.status ?? "")
      )
        return { kind: "unreachable", fullName: head.fullName };
      return {
        kind: "repository",
        head_id: head.id,
        connection_id: head.connectionId,
        owner: head.owner,
        name: head.name,
        full_name: head.fullName,
        default_branch: head.defaultBranch,
      };
    }

    // No head. A sources connection from the old wizard can still name a
    // repository in its delivery config, which the steering seam used to
    // read. The import does not guess that it is the steering repository.
    const [legacy] = await tx
      .select({ deliveryConfig: schema.sourceConnections.deliveryConfig })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, "github"),
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1);
    const config = (legacy?.deliveryConfig ?? {}) as Record<string, unknown>;
    if (typeof config["owner"] === "string" && typeof config["repo"] === "string")
      return {
        kind: "legacy",
        fullName: `${config["owner"]}/${config["repo"]}`,
      };
    return { kind: "none" };
  });
}

/** Set the head's role, under the lock every writer of the heads takes. */
async function setHeadRole(
  scope: ImportScope,
  headId: string,
  role: "linked" | "steering",
): Promise<boolean> {
  return withTenantDb(async (tx) => {
    await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
    if (role === "steering") {
      // Only while the workspace has no steering head: the bind may already
      // have made the new steering repo its head.
      const [steering] = await tx
        .select({ id: schema.repositoryBindingHeads.id })
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.orgId, scope.orgId),
            eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
            inArray(
              schema.repositoryBindingHeads.role,
              schema.STEERING_HEAD_ROLES,
            ),
          ),
        )
        .limit(1);
      if (steering) return false;
    }
    const rows = await tx
      .update(schema.repositoryBindingHeads)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(schema.repositoryBindingHeads.id, headId),
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          ...(role === "steering"
            ? [eq(schema.repositoryBindingHeads.role, "linked")]
            : []),
        ),
      )
      .returning({ id: schema.repositoryBindingHeads.id });
    return rows.length > 0;
  });
}

/** The production dependencies. `actorUserId` authors the steering binding. */
export function steeringImportDeps(options: {
  actorUserId: string;
  env?: Readonly<Record<string, string | undefined>>;
}): SteeringImportDeps {
  return {
    now: () => new Date(),

    // Each import steering PR's `import` proposal row, so a person merges it
    // from Oxagen (#5122, ADR-265). A row that fails to write is logged.
    async recordPullRequest(scope, pr) {
      const [{ personAuthor, recordSteeringPrQuietly }, { postgresSteeringStore }] =
        await Promise.all([import("./pr-proposal"), import("../context.steering.store")]);
      await recordSteeringPrQuietly(postgresSteeringStore, {
        scope,
        repo: pr.repo,
        kind: "import",
        pullRequest: {
          number: pr.number,
          url: pr.url,
          branch: pr.branch,
          headSha: pr.headSha,
        },
        title: pr.title,
        paths: pr.paths,
        check: null,
        author: personAuthor(options.actorUserId),
        rationale: `Oxagen opened this steering PR when it moved the workspace's steering from .oxagen/ to the steering repo. Merge the import's PRs in order from Oxagen, so each lands through the merge queue with the stamp and the ledger line.`,
      });
    },

    async readState(scope) {
      return readImportState(await readSettings(scope));
    },

    async saveState(scope, state) {
      await withTenantDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: settingsPatch(state) })
          .where(workspaceRow(scope)),
      );
    },

    async claim(scope, state, staleBefore) {
      const settings = schema.workspaces.settings;
      const rows = await withTenantDb((tx) =>
        tx
          .update(schema.workspaces)
          .set({ settings: settingsPatch(state) })
          .where(
            and(
              workspaceRow(scope),
              sql`NOT (
                COALESCE(${settings} #>> ${`{${STEERING_IMPORT_SETTING},status}`}::text[], '') = 'running'
                AND COALESCE((${settings} #>> ${`{${STEERING_IMPORT_SETTING},updated_at}`}::text[])::timestamptz, 'epoch'::timestamptz) > ${staleBefore.toISOString()}::timestamptz
              )`,
            ),
          )
          .returning({ id: schema.workspaces.id }),
      );
      return rows.length > 0;
    },

    readSteeringHead,

    demote: (scope, headId) => setHeadRole(scope, headId, "linked"),

    restore: (scope, headId) => setHeadRole(scope, headId, "steering"),

    async provision(scope) {
      const current = readSteeringRepoState(await readSettings(scope));
      if (current?.status === "ready") return;
      // The durable job that create_workspace sent may still be running. Two
      // runs of one step would race on the host, so the import waits for it.
      if (
        current?.status === "provisioning" &&
        current.step !== null &&
        Date.now() - Date.parse(current.updated_at) < PROVISION_QUIET_MS
      )
        throw new HandlerError({
          code: "conflict",
          reason: "steering_repo_provisioning",
          message:
            "The steering repo for this workspace is still being created. Run the import again when it is ready.",
        });
      let status: Awaited<ReturnType<typeof provisionSteeringRepo>>;
      try {
        status = await provisionSteeringRepo(
          steeringRepoProvisionDeps({
            actorUserId: options.actorUserId,
            ...(options.env ? { env: options.env } : {}),
          }),
          { kind: "workspace", orgId: scope.orgId, workspaceId: scope.workspaceId },
        );
      } catch (err) {
        if (err instanceof HandlerError) throw err;
        if (err instanceof SteeringProvisionBlockedError)
          throw new HandlerError({
            code: "conflict",
            reason: err.code,
            message: err.message,
          });
        throw new HandlerError({
          code: "conflict",
          reason: "steering_repo_provision_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (status !== "ready")
        throw new HandlerError({
          code: "conflict",
          reason: "steering_repo_provision_failed",
          message: `Creating the steering repo stopped with status ${status}. Its state names the step that stopped.`,
        });
    },

    async openSource(scope, source) {
      // The binding as the run recorded it, so the seam reads the repository
      // and the production branch the head named when the run began, with the
      // token of the connection it was bound through.
      const host = createSteeringGitHub({
        readConnection: async () => ({
          source: "binding",
          owner: source.owner,
          repo: source.name,
          approvedFullName: source.full_name,
          approvedDefaultRef: source.default_branch,
        }),
        resolveToken: (s) =>
          resolveGitHubToken({ ...s, connectionId: source.connection_id }),
        client: (token) => createGitHubClient({ token }),
      });
      return { host, repo: await host.resolveRepository(scope) };
    },

    async openSteering(scope) {
      const host = createSteeringHost();
      return { host, repo: await host.resolveRepository(scope) };
    },

    async agents(scope) {
      const rows = await withTenantDb((tx) =>
        tx
          .select({
            slug: schema.agents.slug,
            label: schema.agents.name,
            harness: schema.agents.harness,
            runtime: schema.runtimes.slug,
          })
          .from(schema.agents)
          .leftJoin(
            schema.runtimes,
            eq(schema.runtimes.id, schema.agents.runtimeId),
          )
          .where(
            and(
              eq(schema.agents.orgId, scope.orgId),
              eq(schema.agents.workspaceId, scope.workspaceId),
              isNull(schema.agents.deletedAt),
            ),
          ),
      );
      // The agent registry records no operator, so every agent file the
      // import finds is left for a person (the PR body lists them).
      return rows.map((row) => ({
        slug: row.slug,
        label: row.label,
        operator: null,
        runtime: row.runtime ?? null,
        harness: row.harness,
      }));
    },

    async names(scope) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({
            organization: schema.organizations.slug,
            workspace: schema.workspaces.slug,
          })
          .from(schema.workspaces)
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.workspaces.orgId),
          )
          .where(workspaceRow(scope))
          .limit(1),
      );
      if (!row)
        throw new HandlerError({
          code: "not_found",
          reason: "workspace_not_found",
          message: `Workspace ${scope.workspaceId} is not in this organization.`,
        });
      return row;
    },
  };
}
