// steering-repo-backfill.ts: find the workspaces that never started steering
// repo provisioning (#4683).
//
// `create_workspace` provisions a steering repo for each new workspace, and
// ADR-212 made the steering repo the only way to link a code repository. A
// workspace created before that has no steering head and no provisioning
// state, so it cannot link anything. The backfill job
// (functions/steering-repo.backfill.ts) sends the provision event for each
// workspace this module lists.

import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

/** A workspace with no steering head that the backfill should provision. */
export interface HeadlessWorkspace {
  orgId: string;
  workspaceId: string;
  /**
   * The person who created the workspace, or else the organization. The
   * provision job records this person as the author of what it writes. Null
   * when neither row names one, and the job then skips the workspace.
   */
  actorUserId: string | null;
}

/**
 * The filter that picks a headless workspace. It needs every condition:
 *
 * - The workspace is not archived, and its organization is active.
 * - The workspace has no steering head.
 * - Provisioning never started. That covers three states: no state at all,
 *   an event that failed to send (`enqueue_failed`), and a queued state whose
 *   job has not run its first step since `queuedBefore`. A workspace whose
 *   job ran and stopped is left alone. `blocked` waits on a person, and the
 *   connect callback sends the event again. `failed` already spent the job's
 *   retries, so sending it every run would repeat the same failure.
 * - The organization has no dedicated Postgres plane (ADR-042). Such an
 *   organization keeps its heads on that plane, where this read cannot see
 *   them. Provisioning would then create a second steering repo before the
 *   bind step refused it.
 *
 * The state lives under the workspace setting `steering_repo`, the key
 * `STEERING_REPO_SETTING` names in `@oxagen/handlers`. That package depends
 * on this one, so this one cannot import the constant.
 */
export function headlessWorkspaceFilter(options: {
  after: string | null;
  queuedBefore: Date;
}): SQL | undefined {
  const w = schema.workspaces;
  const o = schema.organizations;
  // `updated_at` is an ISO 8601 string from `Date.toISOString()`, so a text
  // comparison orders it by time. A cast would fail the whole read on one
  // malformed value.
  const queuedBefore = options.queuedBefore.toISOString();
  return and(
    isNull(w.archivedAt),
    eq(o.status, "active"),
    sql`not exists (select 1 from ${schema.repositoryBindingHeads} h where h.workspace_id = ${w.id} and ${inArray(sql.raw("h.role"), schema.STEERING_HEAD_ROLES)})`,
    sql`not exists (select 1 from ${schema.dataPlanes} p where p.org_id = ${w.orgId} and p.kind = 'postgres' and p.mode = 'dedicated' and p.deleted_at is null)`,
    sql`(${w.settings} #>> '{steering_repo,status}' is null or ${w.settings} #>> '{steering_repo,error,code}' = 'enqueue_failed' or (${w.settings} #>> '{steering_repo,status}' = 'provisioning' and ${w.settings} #>> '{steering_repo,step}' is null and ${w.settings} #>> '{steering_repo,updated_at}' < ${queuedBefore}))`,
    options.after === null ? undefined : gt(w.id, options.after),
  );
}

/**
 * One page of headless workspaces, ordered by id. Pass the last id of the
 * previous page as `after` to read the next one. A queued workspace counts
 * when its state is older than `queuedBefore`.
 */
export async function listHeadlessWorkspaces(options: {
  after: string | null;
  queuedBefore: Date;
  limit: number;
}): Promise<HeadlessWorkspace[]> {
  const w = schema.workspaces;
  const o = schema.organizations;
  // tenancy: a scheduled global repair across all orgs. It reads only ids
  // and the authoring user, and the provision job it starts re-enters each
  // workspace's own org and workspace scope before it writes.
  return withSystemDb((tx) =>
    tx
      .select({
        orgId: w.orgId,
        workspaceId: w.id,
        actorUserId: sql<
          string | null
        >`coalesce(${w.createdById}, ${o.createdById})`,
      })
      .from(w)
      .innerJoin(o, eq(o.id, w.orgId))
      .where(headlessWorkspaceFilter(options))
      .orderBy(w.id)
      .limit(options.limit),
  );
}

/**
 * Whether the workspace is archived. The provision job reads this before its
 * first step, because a person can archive a workspace between the backfill's
 * read and the job's run. An archived workspace gets no steering repo.
 *
 * A missing row reads false. The provision steps then refuse it with their
 * own `workspace_not_found`, so this read decides only the archived case.
 */
export async function isWorkspaceArchived(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<boolean> {
  const w = schema.workspaces;
  // tenancy: the provision job runs outside a tenant scope, as its steps'
  // own workspace read does. The read is filtered by both orgId and
  // workspaceId, and it returns one timestamp.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ archivedAt: w.archivedAt })
      .from(w)
      .where(and(eq(w.id, scope.workspaceId), eq(w.orgId, scope.orgId)))
      .limit(1),
  );
  return rows[0]?.archivedAt != null;
}
