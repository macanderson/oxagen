// stella-session-archive.ts: the nightly archive of Stella sessions that have
// sat untouched (#4435).
//
// A session is a row in chat.conversations, and every reply bumps its
// updated_at. A session with no reply for a workspace's archive window leaves
// the active list and waits under Archived, where its owner can restore it.
// The window is `[stella] archive_after_days` in the steering repo's
// workspace.toml, which the steering sync publishes into workspaces.settings.
// A workspace that sets none, or holds a value outside 1 to 365, gets 7 days.
//
// The archive is the system's, not a person's: it leaves archived_by_user_id
// null, leaves status alone, and does not touch updated_at, so the list still
// orders an archived session by its last reply.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  STELLA_ARCHIVE_AFTER_DAYS_DEFAULT,
  STELLA_ARCHIVE_AFTER_DAYS_MAX,
  STELLA_ARCHIVE_AFTER_DAYS_MIN,
  STELLA_ARCHIVE_AFTER_DAYS_SETTING,
} from "@oxagen/oxagen/steering-repo/workspace";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

const conversations = schema.conversations;
const workspaces = schema.workspaces;

/** One workspace the sweep visits, with the settings that name its window. */
export interface SweptWorkspace {
  id: string;
  orgId: string;
  settings: unknown;
}

/**
 * The archive window a workspace's settings name, in days. The default when
 * the settings hold no whole number from 1 to 365. The sync writes only valid
 * values, so an out-of-range one means the bag was edited some other way.
 */
export function archiveAfterDays(settings: unknown): number {
  if (typeof settings !== "object" || settings === null) {
    return STELLA_ARCHIVE_AFTER_DAYS_DEFAULT;
  }
  const value = (settings as Record<string, unknown>)[
    STELLA_ARCHIVE_AFTER_DAYS_SETTING
  ];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < STELLA_ARCHIVE_AFTER_DAYS_MIN ||
    value > STELLA_ARCHIVE_AFTER_DAYS_MAX
  ) {
    return STELLA_ARCHIVE_AFTER_DAYS_DEFAULT;
  }
  return value;
}

/** The instant before which a session's last reply makes it archivable. */
export function archiveCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * One page of workspaces in id order, after `after` when it is set. The
 * sweep pages through every workspace this way.
 */
export async function listWorkspacePage(args: {
  after: string | null;
  limit: number;
}): Promise<SweptWorkspace[]> {
  // tenancy: the scheduled archive runs outside a tenant scope and pages
  // through the workspaces of all organizations. Each row carries its own
  // orgId, and the archive writes each workspace in that tenant's scope.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: workspaces.id,
        orgId: workspaces.orgId,
        settings: workspaces.settings,
      })
      .from(workspaces)
      .where(args.after === null ? undefined : gt(workspaces.id, args.after))
      .orderBy(asc(workspaces.id))
      .limit(args.limit),
  );
  return rows;
}

/**
 * Archive every session in one workspace that no one has replied to since
 * `cutoff`, in the workspace's tenant scope. Answers how many it archived.
 * A session a person archived or deleted is left as it is.
 */
export async function archiveIdleSessions(
  workspace: Pick<SweptWorkspace, "id" | "orgId">,
  cutoff: Date,
  now: Date,
): Promise<number> {
  return runInTenantScope(
    { orgId: workspace.orgId, workspaceId: workspace.id },
    () =>
      withTenantDb(async (tx) => {
        const archived = await tx
          .update(conversations)
          .set({ archivedAt: now })
          .where(
            and(
              eq(conversations.workspaceId, workspace.id),
              eq(conversations.orgId, workspace.orgId),
              isNull(conversations.archivedAt),
              isNull(conversations.deletedAt),
              lt(conversations.updatedAt, cutoff),
            ),
          )
          .returning({ id: conversations.id });
        return archived.length;
      }),
  );
}
