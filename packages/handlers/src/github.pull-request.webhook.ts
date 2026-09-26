// audit-exempt: a webhook receiver with no person behind it; the only write is the pull request state a forge reported, onto the rows that name that pull request, which no person authors.
//
// github.pull-request.webhook.ts: what a GitHub App `pull_request` delivery
// does to the stored state of the pull requests runs name (#4129, ADR-189).
//
// The route verified the delivery's HMAC against the App that sent it, so the
// payload is GitHub's word. It carries the repository, the number, the state,
// the draft flag and GitHub's `updated_at`, which is everything a stored row
// needs. No read goes back to GitHub.
//
// Two fences keep one tenant's state out of another's:
//
//   - Only workspaces holding a connected GitHub source for the delivering
//     installation are written. A workspace that recorded a URL to a pull
//     request in someone else's private repository never learns its state.
//   - Each write runs in that workspace's own tenant scope, on its
//     organization's data plane (ADR-042), and names the organization and the
//     workspace in its WHERE clause.
//
// The write is per workspace, not per organization, because the standard
// tenant policy judges an UPDATE by the scope's own workspace. `withOrgDb`
// widens reads only, so an org-wide UPDATE there would change no row.
//
// Deliveries arrive out of order. A write that carries an `updated_at` older
// than the state a row holds leaves the row alone (`applyForgeState`).
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  applyForgeState,
  type ForgeKey,
  type ForgeState,
  githubForgeState,
} from "./lib/run-pull-request-state";
import { logger } from "./logger";

/** One workspace to write. */
export type PullRequestStateScope = { orgId: string; workspaceId: string };

export interface GithubPullRequestStateDeps {
  /** The workspaces holding a connected GitHub source for this installation. */
  connectedScopes(installationId: string): Promise<PullRequestStateScope[]>;
  /** Write the state to the workspace's rows; answers how many it wrote. */
  apply(
    scope: PullRequestStateScope,
    key: ForgeKey,
    forge: ForgeState,
    seenAt: Date,
  ): Promise<number>;
  now(): Date;
}

export type GithubPullRequestStateOutcome =
  | "unreadable"
  | "no_connection"
  | "recorded";

export type GithubPullRequestStateResult = {
  outcome: GithubPullRequestStateOutcome;
  /** Rows written, across every organization. */
  rows: number;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The pull request a delivery names and the state it reports, or null when
 * the payload does not carry one GitHub always sends.
 */
export function pullRequestDeliveryOf(
  body: Record<string, unknown>,
): { key: ForgeKey; forge: ForgeState } | null {
  const repository = (body.repository ?? {}) as { full_name?: unknown };
  const pr = (body.pull_request ?? null) as Record<string, unknown> | null;
  const fullName = str(repository.full_name);
  if (pr === null || fullName === null || !fullName.includes("/")) return null;
  const number = pr.number;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return null;
  const forge = githubForgeState(pr);
  if (forge === null) return null;
  return {
    key: { provider: "github", repository: fullName.toLowerCase(), number },
    forge,
  };
}

/**
 * Record the state a `pull_request` delivery reports. The route calls this
 * once per delivery and never lets it fail the delivery.
 *
 * One workspace's failed write does not stop the others: each workspace is
 * written, and then the failures are thrown together so the route logs them.
 */
export async function recordGithubPullRequestState(
  deps: GithubPullRequestStateDeps,
  args: { body: Record<string, unknown>; installationId: string },
): Promise<GithubPullRequestStateResult> {
  const delivery = pullRequestDeliveryOf(args.body);
  if (delivery === null) return { outcome: "unreadable", rows: 0 };
  const scopes = await deps.connectedScopes(args.installationId);
  if (scopes.length === 0) return { outcome: "no_connection", rows: 0 };
  const seenAt = deps.now();
  let rows = 0;
  const failures: unknown[] = [];
  for (const scope of scopes) {
    try {
      rows += await deps.apply(scope, delivery.key, delivery.forge, seenAt);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `github.pull-request.webhook: ${failures.length} of ${scopes.length} workspaces could not store the state; ${rows} rows were written`,
    );
  return { outcome: "recorded", rows };
}

/** The real dependencies: the shared connection registry and each org's plane. */
export const githubPullRequestStateDeps: GithubPullRequestStateDeps = {
  async connectedScopes(installationId) {
    // tenancy: webhook routing before any tenant is known; the route verified
    // the delivery's HMAC, and this reads only the org and workspace of the
    // connected GitHub sources filtered by the delivering installation id.
    const rows = await withSystemDb((tx) =>
      tx
        .selectDistinct({
          orgId: schema.sourceConnections.orgId,
          workspaceId: schema.sourceConnections.workspaceId,
        })
        .from(schema.sourceConnections)
        .where(
          and(
            eq(schema.sourceConnections.connectorId, "github"),
            eq(schema.sourceConnections.status, "connected"),
            sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${installationId}`,
            isNull(schema.sourceConnections.deletedAt),
          ),
        )
        .orderBy(
          schema.sourceConnections.orgId,
          schema.sourceConnections.workspaceId,
        ),
    );
    return rows;
  },
  async apply(scope, key, forge, seenAt) {
    const written = await runInTenantScope(scope, () =>
      withTenantDb((tx) => applyForgeState(tx, scope, key, forge, seenAt)),
    );
    if (written.length > 0)
      logger.info(
        {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          repository: key.repository,
          number: key.number,
          state: forge.state,
          rows: written.length,
        },
        "github.pull-request.webhook: stored a pull request's state",
      );
    return written.length;
  },
  now: () => new Date(),
};
