// The one read that fills a pull request's state when a run first records
// its link (#4129, ADR-189).
//
// Forge webhooks keep a stored state current, but the delivery that opened a
// pull request usually arrives before the harness writes the frame that
// names it, and it finds no row to write. So when the ingest lands a link it
// sends `run/pull-request.linked`, and this:
//
//   1. inserts the row for the root session and URL, with no state,
//   2. reads the pull request's state once from the forge, with the
//      workspace's own connection, and
//   3. writes it under the same newer-wins rule the webhooks use.
//
// A workspace with no connection that reaches the repository keeps the row
// with a null state, and the page says "status unknown". A forge that answers
// 403, 404 or 410 is the same: the workspace's credentials cannot read it.
// Any other failure throws, and the durable function retries.
import { schema, withTenantDb } from "@oxagen/database";
import { createGitHubClient, GitHubApiError } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import { createGitLabClient, GitLabApiError } from "@oxagen/gitlab";
import type { PullRequestBackfillRequest } from "@oxagen/inngest-functions/run-pull-request-backfill-runner";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../logger";
import { findWorkspaceGitLabConnection } from "../repository.gitlab-connection";
import { resolveGitLabCredential } from "./gitlab-credential";
import {
  applyForgeState,
  type ForgeKey,
  type ForgeState,
  forgeKeyOf,
  githubForgeState,
  gitlabForgeState,
  insertRunPullRequest,
} from "./run-pull-request-state";

type Scope = { orgId: string; workspaceId: string };

/** What the live read found: a state, or why there is none. */
export type ForgeRead = ForgeState | "no_connection" | "unreadable";

export interface PullRequestBackfillDeps {
  /** The root session's internal id for its uuid, or null. */
  rootSessionId(scope: Scope, sessionUuid: string): Promise<string | null>;
  /** Insert the row with no state; a second insert does nothing. */
  insertRow(
    scope: Scope,
    row: { sessionId: string; url: string; key: ForgeKey },
  ): Promise<void>;
  /** Read the state from the forge with the workspace's own connection. */
  readForge(scope: Scope, key: ForgeKey): Promise<ForgeRead>;
  /** Write the state under newer-wins; answers the rows written. */
  apply(
    scope: Scope,
    key: ForgeKey,
    forge: ForgeState,
    seenAt: Date,
  ): Promise<number>;
  now(): Date;
}

export type PullRequestBackfillOutcome =
  | "not_a_forge_link"
  | "no_session"
  | "no_connection"
  | "unreadable"
  | "recorded";

export type PullRequestBackfillResult = {
  outcome: PullRequestBackfillOutcome;
  /** Rows the read's state was written to. */
  rows: number;
};

export async function backfillRunPullRequest(
  deps: PullRequestBackfillDeps,
  request: PullRequestBackfillRequest,
): Promise<PullRequestBackfillResult> {
  const key = forgeKeyOf(request.url);
  if (key === null) return { outcome: "not_a_forge_link", rows: 0 };
  const scope = { orgId: request.orgId, workspaceId: request.workspaceId };
  const sessionId = await deps.rootSessionId(scope, request.rootSessionUuid);
  if (sessionId === null) return { outcome: "no_session", rows: 0 };
  await deps.insertRow(scope, { sessionId, url: request.url, key });
  const read = await deps.readForge(scope, key);
  if (read === "no_connection" || read === "unreadable")
    return { outcome: read, rows: 0 };
  const rows = await deps.apply(scope, key, read, deps.now());
  return { outcome: "recorded", rows };
}

/** A forge answer that says the credentials cannot see the pull request. */
function unreadableStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 410;
}

const connections = schema.sourceConnections;

/**
 * The workspace's connected GitHub source for the repository's owner. An
 * installation belongs to one account, so the owner is what decides whether
 * its token can read the repository; GitHub answers 404 when it cannot.
 */
async function githubConnectionFor(
  scope: Scope,
  owner: string,
): Promise<string | null> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.orgId, scope.orgId),
          eq(connections.workspaceId, scope.workspaceId),
          eq(connections.connectorId, "github"),
          eq(connections.status, "connected"),
          isNull(connections.deletedAt),
          sql`lower(${connections.deliveryConfig} ->> 'owner') = ${owner}`,
        ),
      )
      .orderBy(desc(connections.createdAt))
      .limit(1),
  );
  return row?.id ?? null;
}

async function readGithub(scope: Scope, key: ForgeKey): Promise<ForgeRead> {
  const [owner = "", repo = ""] = key.repository.split("/");
  const connectionId = await githubConnectionFor(scope, owner);
  if (connectionId === null) return "no_connection";
  const client = createGitHubClient({
    token: await resolveGitHubToken({ ...scope, connectionId }),
  });
  try {
    const pr = await client.getPullRequest({ owner, repo, number: key.number });
    return githubForgeState(pr) ?? "unreadable";
  } catch (err) {
    if (err instanceof GitHubApiError && unreadableStatus(err.status))
      return "unreadable";
    throw err;
  }
}

async function readGitlab(scope: Scope, key: ForgeKey): Promise<ForgeRead> {
  const connection = await findWorkspaceGitLabConnection(scope, {
    path: key.repository,
  });
  if (connection === null || connection.status !== "connected")
    return "no_connection";
  const credential = await resolveGitLabCredential({
    ...scope,
    connectionId: connection.id,
  });
  const client = createGitLabClient({ token: credential.token });
  try {
    const mr = await client.getMergeRequest({
      project: connection.config.projectId,
      iid: key.number,
    });
    return gitlabForgeState(mr) ?? "unreadable";
  } catch (err) {
    if (err instanceof GitLabApiError && unreadableStatus(err.status))
      return "unreadable";
    throw err;
  }
}

/** The real dependencies. The runner calls them inside the event's tenant scope. */
export const pullRequestBackfillDeps: PullRequestBackfillDeps = {
  async rootSessionId(scope, sessionUuid) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.tachoSessions.id })
        .from(schema.tachoSessions)
        .where(
          and(
            eq(schema.tachoSessions.orgId, scope.orgId),
            eq(schema.tachoSessions.workspaceId, scope.workspaceId),
            eq(schema.tachoSessions.sessionUuid, sessionUuid),
            isNull(schema.tachoSessions.parentSessionUuid),
          ),
        )
        .limit(1),
    );
    return row?.id ?? null;
  },
  async insertRow(scope, row) {
    await withTenantDb((tx) => insertRunPullRequest(tx, { ...scope, ...row }));
  },
  readForge: (scope, key) =>
    key.provider === "github" ? readGithub(scope, key) : readGitlab(scope, key),
  async apply(scope, key, forge, seenAt) {
    const written = await withTenantDb((tx) =>
      applyForgeState(tx, scope, key, forge, seenAt),
    );
    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        provider: key.provider,
        number: key.number,
        state: forge.state,
        rows: written.length,
      },
      "run.pull-request-backfill: read a linked pull request's state",
    );
    return written.length;
  },
  now: () => new Date(),
};
