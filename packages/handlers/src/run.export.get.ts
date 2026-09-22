// `get_run_export`: read one run export back, with a download URL once the
// bundle is built (Mission Control spec §13.4, App. E; ADR-058).
//
// Guards, each with its negative test: org Owner or Admin (`assertOrgRole`,
// the same gate as `export_run`); the export row is in the caller's workspace
// (`not_found` otherwise, and the query filters on org and workspace as well
// as RLS). The download URL is minted only for a `ready` row, signed over the
// row's own bundle digest, and expires after
// `RUN_EXPORT_DOWNLOAD_TTL_SECONDS`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  RUN_EXPORT_DOWNLOAD_TTL_SECONDS,
  runExportGet,
  type RunExportGetOutput,
} from "@oxagen/oxagen/contracts/run.export.get";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { runScope } from "./run.list";
import {
  mintRunExportDownloadToken,
  runExportDownloadSecret,
  runExportDownloadUrl,
} from "./lib/run-export-download";

const EXPORT_ROLES = ["Owner", "Admin"] as const;

export interface RunExportRow {
  publicId: string;
  runPublicId: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  bundleDigest: string | null;
  bundleBytes: number | null;
  merkleRoot: string | null;
  frameCount: number | null;
  error: string | null;
}

export interface RunExportGetDeps {
  readExport: (scope: {
    orgId: string;
    workspaceId: string;
    exportId: string;
  }) => Promise<RunExportRow | null>;
  secret: () => string;
  now: () => Date;
}

const STATUSES = new Set(["queued", "building", "ready", "failed"]);

export function createRunExportGetHandler(
  deps: RunExportGetDeps,
): CapabilityHandler<typeof runExportGet> {
  return async (input, ctx): Promise<RunExportGetOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: EXPORT_ROLES },
    );
    const scope = runScope(ctx);
    const row = await deps.readExport({ ...scope, exportId: input.exportId });
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "run_export_not_found",
      });
    }
    if (!STATUSES.has(row.status)) {
      // The table's check constraint admits these four alone; anything else
      // is a schema the contract has not caught up with, not a status.
      throw new Error(`run export ${row.publicId} has status ${row.status}`);
    }
    const status = row.status as RunExportGetOutput["status"];

    let download: RunExportGetOutput["download"] = null;
    if (status === "ready" && row.bundleDigest !== null) {
      const now = deps.now();
      const exp =
        Math.floor(now.getTime() / 1000) + RUN_EXPORT_DOWNLOAD_TTL_SECONDS;
      const token = mintRunExportDownloadToken(
        {
          exportId: row.publicId,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          bundleDigest: row.bundleDigest,
          exp,
        },
        deps.secret(),
      );
      download = {
        url: runExportDownloadUrl(token),
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    }

    return {
      exportId: row.publicId,
      runId: row.runPublicId,
      status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      bundleDigest: row.bundleDigest,
      bundleBytes: row.bundleBytes,
      merkleRoot: row.merkleRoot,
      frameCount: row.frameCount,
      error: row.error,
      download,
    };
  };
}

/** One export row by public id, filtered to the caller's org and workspace. */
export async function readRunExportRow(scope: {
  orgId: string;
  workspaceId: string;
  exportId: string;
}): Promise<(RunExportRow & { bundleRef: string | null }) | null> {
  const t = schema.runExports;
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: t.publicId,
        runPublicId: t.runPublicId,
        status: t.status,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        bundleRef: t.bundleRef,
        bundleDigest: t.bundleDigest,
        bundleBytes: t.bundleBytes,
        merkleRoot: t.merkleRoot,
        frameCount: t.frameCount,
        error: t.error,
      })
      .from(t)
      .where(
        and(
          eq(t.publicId, scope.exportId),
          eq(t.orgId, scope.orgId),
          eq(t.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

export const runExportGetHandler = createRunExportGetHandler({
  readExport: readRunExportRow,
  secret: runExportDownloadSecret,
  now: () => new Date(),
});
