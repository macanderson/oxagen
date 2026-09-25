// repository.working_copy.list.ts — `list_working_copies` (MC spec §10.1, the
// Working copies tab).
//
// Every directory the CLI reported for this workspace, most recently seen
// first. The rows are what `record_working_copy` received and nothing more:
// no working tree is read here, so each row describes its directory as of its
// `lastSeenAt`.
//
// The reporter's name comes from `auth.users.display_name`, joined on the
// row's own `reported_by_id` (a direct foreign key, the same join the audit
// log makes for its actor). A report sent with an API key carries no user, so
// its `reportedBy` is null.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workingCopyList,
  type WorkingCopyListOutput,
  type WorkingCopyRow,
} from "@oxagen/oxagen/contracts/repository.working_copy.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";

type Scope = { orgId: string; workspaceId: string };

/** One stored row with its reporter's display name, as the read selects it. */
export interface StoredWorkingCopy {
  publicId: string;
  hostname: string;
  directory: string;
  repositoryFullName: string | null;
  branch: string | null;
  headCommit: string | null;
  oxagenPresent: boolean;
  symlinks: string;
  pulledCommit: string | null;
  lastEvent: string;
  cliVersion: string | null;
  reportedById: string | null;
  reporterName: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface WorkingCopyListDeps {
  read(scope: Scope, limit: number): Promise<StoredWorkingCopy[]>;
}

/** The workspace's rows, newest `last_seen_at` first, at most `limit`. */
export const readWorkingCopies: WorkingCopyListDeps["read"] = (scope, limit) =>
  withTenantDb((tx) => {
    const t = schema.workingCopies;
    return tx
      .select({
        publicId: t.publicId,
        hostname: t.hostname,
        directory: t.directory,
        repositoryFullName: t.repositoryFullName,
        branch: t.branch,
        headCommit: t.headCommit,
        oxagenPresent: t.oxagenPresent,
        symlinks: t.symlinks,
        pulledCommit: t.pulledCommit,
        lastEvent: t.lastEvent,
        cliVersion: t.cliVersion,
        reportedById: t.reportedById,
        reporterName: schema.users.displayName,
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
      })
      .from(t)
      .leftJoin(schema.users, eq(schema.users.id, t.reportedById))
      .where(
        and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId)),
      )
      .orderBy(desc(t.lastSeenAt), desc(t.id))
      .limit(limit);
  });

/** The two columns a CHECK constraint bounds, narrowed to the contract's words. */
function symlinksOf(value: string): WorkingCopyRow["symlinks"] {
  return value === "linked" || value === "missing" ? value : "none";
}

function eventOf(value: string): WorkingCopyRow["lastEvent"] {
  return value === "pull" ? "pull" : "init";
}

/** One stored row in the contract's shape. */
export function toWorkingCopyRow(row: StoredWorkingCopy): WorkingCopyRow {
  return {
    id: row.publicId,
    hostname: row.hostname,
    directory: row.directory,
    repository: row.repositoryFullName,
    branch: row.branch,
    headCommit: row.headCommit,
    oxagenPresent: row.oxagenPresent,
    symlinks: symlinksOf(row.symlinks),
    pulledCommit: row.pulledCommit,
    lastEvent: eventOf(row.lastEvent),
    reportedBy:
      row.reportedById === null
        ? null
        : { userId: row.reportedById, name: row.reporterName },
    cliVersion: row.cliVersion,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export function createWorkingCopyListHandler(
  deps: WorkingCopyListDeps,
): CapabilityHandler<typeof workingCopyList> {
  return async (input, ctx): Promise<WorkingCopyListOutput> => {
    const rows = await deps.read(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.limit,
    );
    return { workingCopies: rows.map(toWorkingCopyRow) };
  };
}

export const workingCopyListHandler = createWorkingCopyListHandler({
  read: readWorkingCopies,
});
