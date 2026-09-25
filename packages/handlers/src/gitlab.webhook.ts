// audit-exempt: an unauthenticated webhook receiver; the only writes are a proposal rejected because its merge request was closed on GitLab, a connection marked errored after GitLab rejected its token, a project path label, and a repository sync request. None is a privileged mutation a person makes.
//
// gitlab.webhook.ts: what a GitLab project webhook delivery does (#3762).
//
// The webhook is a trigger. The GitLab API is the truth. A delivery never acts
// on the state its payload claims: for every merge request event the receiver
// re-reads the merge request through the stored token and acts on its CURRENT
// state. Two properties follow from that without any delivery log:
//
// - A duplicate delivery reads the same current state as the first one and
//   finds nothing left to change.
// - An out-of-order delivery reads today's state, not the state it carried.
//   A stale "opened" event for a merge request since closed still rejects its
//   proposal; a stale "closed" event for one since reopened does not.
//
// Authentication is the secret token GitLab echoes in `X-Gitlab-Token`,
// compared in constant time against the secret `attach_gitlab_project` stored
// with the connection. An unknown connection, a retired one and a wrong token
// all answer the same 401, so the route does not say which ids exist.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  createGitLabClient,
  GitLabApiError,
  parseGitLabWebhookEvent,
  verifyGitLabWebhookToken,
  type GitLabClient,
} from "@oxagen/gitlab";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  decryptGitLabCredential,
  GITLAB_PROVIDER,
} from "./lib/gitlab-credential";
import { logger } from "./logger";
import { gitlabDeliveryConfigOf } from "./repository.gitlab-connection";
import { postgresSteeringStore } from "./context.steering.store";

const OPEN_PR: readonly ProposalStatus[] = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
];

/** What the connection lookup answers: the tenant, the project, the secrets. */
export interface WebhookConnection {
  id: string;
  orgId: string;
  workspaceId: string;
  projectId: string;
  projectPath: string;
  token: string;
  webhookSecret: string;
}

export interface WebhookScope {
  orgId: string;
  workspaceId: string;
}

export interface GitLabWebhookDeps {
  /** A live GitLab connection by public id, with its decrypted credential. */
  findConnection(publicId: string): Promise<WebhookConnection | null>;
  /** Replace the connection's project path label. */
  updateConnectionPath(
    connectionId: string,
    projectPath: string,
  ): Promise<void>;
  /** Mark the connection errored because GitLab rejected its token. */
  markCredentialRejected(connectionId: string): Promise<void>;
  /** The open proposal whose GitLab merge request has this IID. */
  findOpenProposal(
    scope: WebhookScope,
    iid: number,
  ): Promise<{ id: string; publicId: string } | null>;
  /** Reject an open proposal; false when it had already moved. */
  rejectProposal(id: string, reason: string, at: Date): Promise<boolean>;
  client(token: string): GitLabClient;
  now(): Date;
  runInScope<T>(scope: WebhookScope, fn: () => Promise<T>): Promise<T>;
  /**
   * Ask for the repository sync (ADR-184). A push or a merge on GitLab can
   * change the records in force, and the sync reads the branch itself.
   */
  requestSync?(scope: WebhookScope, reason: string): Promise<void>;
}

export interface GitLabWebhookRequest {
  connectionPublicId: string;
  tokenHeader: string | null;
  body: unknown;
}

export type GitLabWebhookOutcome =
  | "unauthenticated"
  | "ignored_unparseable"
  | "ignored_other_project"
  | "ignored_event"
  | "no_proposal"
  | "credential_rejected"
  | "proposal_rejected"
  | "proposal_moved"
  | "merged_awaiting_publication"
  | "sync_requested"
  | "no_change";

export interface GitLabWebhookResult {
  status: 200 | 202 | 401;
  outcome: GitLabWebhookOutcome;
}

/**
 * Whether a GitLab push event names the project's default branch. True when
 * the payload leaves either out, so a payload shape this does not know still
 * asks for a sync rather than dropping one.
 */
function pushesDefaultBranch(body: unknown): boolean {
  const b = (body ?? {}) as {
    ref?: unknown;
    project?: { default_branch?: unknown } | null;
  };
  const ref = typeof b.ref === "string" ? b.ref : null;
  const branch =
    typeof b.project?.default_branch === "string"
      ? b.project.default_branch
      : null;
  return ref === null || branch === null || ref === `refs/heads/${branch}`;
}

/** Why a proposal is rejected when its merge request closes on GitLab. */
export const CLOSED_ON_GITLAB = "Merge request closed on GitLab";

export async function handleGitLabWebhook(
  deps: GitLabWebhookDeps,
  req: GitLabWebhookRequest,
): Promise<GitLabWebhookResult> {
  const connection = await deps.findConnection(req.connectionPublicId);
  if (
    !connection ||
    !verifyGitLabWebhookToken(req.tokenHeader, connection.webhookSecret)
  )
    return { status: 401, outcome: "unauthenticated" };

  const event = parseGitLabWebhookEvent(req.body);
  if (!event) return { status: 202, outcome: "ignored_unparseable" };
  // A hook copied onto another project, or a project the connection no
  // longer names, must not act on this connection's project.
  if (event.projectId !== null && event.projectId !== connection.projectId)
    return { status: 202, outcome: "ignored_other_project" };

  const gl = deps.client(connection.token);
  const scope = {
    orgId: connection.orgId,
    workspaceId: connection.workspaceId,
  };

  try {
    const reportedPath = event.projectPathWithNamespace;
    if (reportedPath && reportedPath !== connection.projectPath) {
      // The payload says the project moved. Only the API's answer moves the
      // label. The binding keeps its approved name until an owner re-binds.
      const project = await gl.getProject(connection.projectId);
      if (project.pathWithNamespace !== connection.projectPath) {
        await deps.updateConnectionPath(
          connection.id,
          project.pathWithNamespace,
        );
        logger.info(
          {
            connectionId: connection.id,
            projectId: connection.projectId,
            from: connection.projectPath,
            to: project.pathWithNamespace,
          },
          "gitlab.webhook: the project moved; its path label follows",
        );
      }
    }

    if (event.kind === "other" && event.objectKind === "push") {
      // Only a push to the project's default branch can move steering. A
      // push elsewhere would only put the page into "pending" for nothing.
      // The payload is a hint, not the truth: the sync reads the approved
      // branch itself, and a payload that names no branch still asks.
      if (!deps.requestSync || !pushesDefaultBranch(req.body))
        return { status: 202, outcome: "ignored_event" };
      await deps.requestSync(scope, "push");
      return { status: 202, outcome: "sync_requested" };
    }
    if (event.kind !== "merge_request")
      return { status: 202, outcome: "ignored_event" };

    return await deps.runInScope(scope, async () => {
      // Any merge can change the production branch, whether or not Oxagen
      // opened the merge request. The payload's word is enough to ask: the
      // sync reads the branch, and finds nothing when nothing merged.
      if (event.state === "merged" && deps.requestSync)
        await deps.requestSync(scope, "merge_request");
      const proposal = await deps.findOpenProposal(scope, event.iid);
      if (!proposal) return { status: 202, outcome: "no_proposal" } as const;
      const mr = await gl.getMergeRequest({
        project: connection.projectId,
        iid: event.iid,
      });
      if (mr.state === "merged")
        // The repository sync publishes what merged (ADR-184). A merge made
        // from Oxagen publishes itself first, and the sync finds nothing left.
        return {
          status: 202,
          outcome: "merged_awaiting_publication",
        } as const;
      if (mr.state !== "closed")
        return { status: 202, outcome: "no_change" } as const;
      const rejected = await deps.rejectProposal(
        proposal.id,
        CLOSED_ON_GITLAB,
        deps.now(),
      );
      return rejected
        ? ({ status: 200, outcome: "proposal_rejected" } as const)
        : ({ status: 202, outcome: "proposal_moved" } as const);
    });
  } catch (err) {
    if (err instanceof GitLabApiError && err.status === 401) {
      // The token was revoked or expired. Steering already refuses through
      // the seam; the connection says why, without the token.
      await deps.markCredentialRejected(connection.id);
      logger.warn(
        { connectionId: connection.id, projectId: connection.projectId },
        "gitlab.webhook: GitLab rejected the stored project access token",
      );
      return { status: 202, outcome: "credential_rejected" };
    }
    throw err;
  }
}

/** The real dependencies: Postgres, the envelope key, and gitlab.com. */
export function gitlabWebhookDeps(): GitLabWebhookDeps {
  return {
    async findConnection(publicId) {
      // tenancy: webhook lookup with no tenant scope yet; filtered by the
      // connection public id, and the caller verifies the delivery's
      // secret token before anything the row names is used.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            id: schema.sourceConnections.id,
            orgId: schema.sourceConnections.orgId,
            workspaceId: schema.sourceConnections.workspaceId,
            deliveryConfig: schema.sourceConnections.deliveryConfig,
            encryptedPayload: schema.authCredentials.encryptedPayload,
          })
          .from(schema.sourceConnections)
          .innerJoin(
            schema.authCredentials,
            eq(
              schema.authCredentials.connectionId,
              schema.sourceConnections.id,
            ),
          )
          .where(
            and(
              eq(schema.sourceConnections.publicId, publicId),
              eq(schema.sourceConnections.connectorId, GITLAB_PROVIDER),
              isNull(schema.sourceConnections.deletedAt),
              notInArray(schema.sourceConnections.status, [
                "deleting",
                "deleted",
              ]),
            ),
          )
          .limit(1),
      );
      if (!row) return null;
      // The config first: a row that names no GitLab project is no connection
      // this route serves, whatever its credential. A decrypt that throws (the
      // key service is down) is left to throw, so GitLab gets a 5xx and
      // retries rather than a 401 that counts toward disabling the hook.
      const config = gitlabDeliveryConfigOf(row.deliveryConfig);
      if (!config) return null;
      const credential = await decryptGitLabCredential(row.encryptedPayload);
      if (!credential) return null;
      return {
        id: row.id,
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        projectId: config.projectId,
        projectPath: config.projectPath,
        token: credential.token,
        webhookSecret: credential.webhookSecret,
      };
    },
    async updateConnectionPath(connectionId, projectPath) {
      // tenancy: webhook write filtered by the connection id resolved from an
      // authenticated delivery (verified secret token), one row only.
      await withSystemDb(async (tx) => {
        const [row] = await tx
          .select({ deliveryConfig: schema.sourceConnections.deliveryConfig })
          .from(schema.sourceConnections)
          .where(eq(schema.sourceConnections.id, connectionId))
          .limit(1);
        const config = gitlabDeliveryConfigOf(row?.deliveryConfig);
        if (!config) return;
        await tx
          .update(schema.sourceConnections)
          .set({
            deliveryConfig: { ...config, projectPath },
            updatedAt: new Date(),
          })
          .where(eq(schema.sourceConnections.id, connectionId));
      });
    },
    async markCredentialRejected(connectionId) {
      // tenancy: webhook write filtered by the connection id resolved from an
      // authenticated delivery (verified secret token), one row only.
      await withSystemDb((tx) =>
        tx
          .update(schema.sourceConnections)
          .set({
            status: "error",
            errorMessage: "GitLab rejected the stored project access token",
            lastErrorAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.sourceConnections.id, connectionId)),
      );
    },
    async findOpenProposal(scope, iid) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({
            id: schema.contextProposals.id,
            publicId: schema.contextProposals.publicId,
          })
          .from(schema.contextProposals)
          .where(
            and(
              eq(schema.contextProposals.orgId, scope.orgId),
              eq(schema.contextProposals.workspaceId, scope.workspaceId),
              eq(schema.contextProposals.provider, GITLAB_PROVIDER),
              eq(schema.contextProposals.prNumber, iid),
              inArray(schema.contextProposals.status, [...OPEN_PR]),
            ),
          )
          .limit(1),
      );
      return row ?? null;
    },
    async rejectProposal(id, reason, at) {
      try {
        await postgresSteeringStore.updateProposal(
          id,
          { status: "rejected", dismissedAt: at, dismissedReason: reason },
          OPEN_PR,
        );
        return true;
      } catch (err) {
        // The store refuses a proposal that already left the open states:
        // a concurrent merge, dismissal, or an earlier delivery.
        if ((err as { code?: unknown }).code === "conflict") return false;
        throw err;
      }
    },
    client: (token) => createGitLabClient({ token }),
    now: () => new Date(),
    runInScope: (scope, fn) => runInTenantScope(scope, fn),
    async requestSync(scope, reason) {
      // A request that cannot be sent must not fail the delivery: GitLab
      // retries a 5xx and disables a hook that keeps failing, which would
      // also stop the merge request events that reject closed proposals. The
      // five-minute sweep syncs the workspace anyway.
      try {
        const { requestSteeringSync } = await import(
          "./context.steering.sync.request"
        );
        await requestSteeringSync([scope], reason);
      } catch (err) {
        logger.error(
          { err, workspaceId: scope.workspaceId, reason },
          "gitlab.webhook: could not request a steering sync; the scheduled sweep will run it",
        );
      }
    },
  };
}
