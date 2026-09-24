// repository.working_copy.record.ts — `record_working_copy` (MC spec §10.1,
// the Working copies tab).
//
// `oxagen init` and `oxagen pull` report a directory they linked to this
// workspace. One row per (org, workspace, machine, directory): the first
// report inserts it, and every later report from the same pair overwrites
// what the machine can see now (remote, branch, head, the state of
// `.oxagen/`, the commit last pulled), who sent it, and `last_seen_at`. The
// row keeps its `first_seen_at` and its public id, so a link the page shows
// survives every report after the first.
//
// The write runs inside `withTenantDb`, so RLS bounds it to the caller's
// workspace as well as the explicit org and workspace values it carries.
// audit-exempt: a working-copy report grants nothing and changes no access;
// the kernel's capability.invoke_* audit covers who sent it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workingCopyRecord,
  type WorkingCopyRecordInput,
  type WorkingCopyRecordOutput,
} from "@oxagen/oxagen/contracts/repository.working_copy.record";
import { schema, withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";

type Scope = { orgId: string; workspaceId: string };

/** The row the upsert answers: its public id and the two instants. */
export interface RecordedWorkingCopy {
  publicId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** What one report writes, keyed by the unique (org, workspace, machine, directory). */
export interface WorkingCopyReport {
  machineId: string;
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
}

export interface WorkingCopyRecordDeps {
  upsert(scope: Scope, report: WorkingCopyReport): Promise<RecordedWorkingCopy>;
}

/** The report a contract input and the caller's user make. */
export function toReport(
  input: WorkingCopyRecordInput,
  userId: string | null,
): WorkingCopyReport {
  return {
    machineId: input.machineId,
    hostname: input.hostname,
    directory: input.directory,
    repositoryFullName: input.repository,
    branch: input.branch,
    headCommit: input.headCommit,
    oxagenPresent: input.oxagenPresent,
    symlinks: input.symlinks,
    pulledCommit: input.pulledCommit,
    lastEvent: input.event,
    cliVersion: input.cliVersion,
    reportedById: userId,
  };
}

/**
 * Insert the row, or update the one the unique key already names. The update
 * sets every reported column and `last_seen_at`; `first_seen_at` and
 * `public_id` are left as the first report wrote them.
 */
export const upsertWorkingCopy: WorkingCopyRecordDeps["upsert"] = (
  scope,
  report,
) =>
  withTenantDb(async (tx) => {
    const t = schema.workingCopies;
    const [row] = await tx
      .insert(t)
      .values({ ...report, orgId: scope.orgId, workspaceId: scope.workspaceId })
      .onConflictDoUpdate({
        target: [t.orgId, t.workspaceId, t.machineId, t.directory],
        set: {
          hostname: report.hostname,
          repositoryFullName: report.repositoryFullName,
          branch: report.branch,
          headCommit: report.headCommit,
          oxagenPresent: report.oxagenPresent,
          symlinks: report.symlinks,
          pulledCommit: report.pulledCommit,
          lastEvent: report.lastEvent,
          cliVersion: report.cliVersion,
          reportedById: report.reportedById,
          lastSeenAt: sql`now()`,
        },
      })
      .returning({
        publicId: t.publicId,
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
      });
    if (!row) throw new Error("working copy upsert returned no row");
    return row;
  });

export function createWorkingCopyRecordHandler(
  deps: WorkingCopyRecordDeps,
): CapabilityHandler<typeof workingCopyRecord> {
  return async (input, ctx): Promise<WorkingCopyRecordOutput> => {
    const row = await deps.upsert(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      toReport(input, ctx.userId ?? null),
    );
    return {
      workingCopyId: row.publicId,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    };
  };
}

export const workingCopyRecordHandler = createWorkingCopyRecordHandler({
  upsert: upsertWorkingCopy,
});
