// get_export_status: where one of the calling person's own exports has got to.
//
// `privacy.privacy_export_requests` is a person-keyed table with no
// workspace_id and is not under RLS, so withSystemDb is the executor, same as
// the write beside it. The acting user id comes from the capability context
// principal and is part of the match, never from input: the contract carries
// no user id, so there is no way to ask after anyone else's bundle. An id that
// exists but belongs to someone else is `not_found`, not `forbidden` — a
// refusal that distinguished the two would answer whether a stranger's export
// id is real.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

/**
 * The canonical object key from whatever `export_url` holds.
 *
 * Rows written before this change stored `result.url`, and on Vercel Blob that
 * is a full authenticated URL, not a key: the driver returns `url: result.url`
 * and `key: result.pathname`, which differ. `storage().get()` accepts only a
 * canonical key, so an older ready row would read as ready and then fail to
 * download. Both representations are accepted here rather than the rows being
 * migrated, because the pathname is recoverable from the URL exactly and a
 * backfill would have to reach every data plane (ADR-042).
 *
 * The filesystem driver returns `url: input.key`, so its rows need nothing.
 */
export function exportObjectKey(stored: string): string {
  if (!/^https?:\/\//i.test(stored)) return stored;
  try {
    return new URL(stored).pathname.replace(/^\/+/, "");
  } catch {
    // Not parseable as a URL after all. It is whatever it is, and get() will
    // refuse it rather than this returning something invented.
    return stored;
  }
}

export const privacyDataExportStatusHandler: CapabilityHandler<
  typeof privacyDataExportStatus
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  const userId = ctx.userId;

  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.privacyExportRequests.id,
        status: schema.privacyExportRequests.status,
        exportUrl: schema.privacyExportRequests.exportUrl,
        completedAt: schema.privacyExportRequests.completedAt,
      })
      .from(schema.privacyExportRequests)
      .where(
        and(
          eq(schema.privacyExportRequests.id, input.exportId),
          eq(schema.privacyExportRequests.userId, userId),
          // The governed organisation as well as the person. IAM resolves
          // this capability against ctx.orgId, so without this an export
          // queued in org A stays readable through a membership in org B
          // after the caller has lost A — the read would answer for a
          // tenant whose rules never governed it. This is the rule the
          // org-scope branch of `export_data` applies at dispatch, arriving
          // where the row is actually read.
          eq(schema.privacyExportRequests.orgId, ctx.orgId),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) {
    throw new HandlerError({ code: "not_found", reason: "export_not_found" });
  }

  // export_url holds the storage KEY, not a browser URL: the archive is a
  // private object, and the storage contract forbids rendering a private
  // object's url (Vercel Blob needs the store token; the filesystem driver
  // returns the key itself). A key left on a row that has since failed is not
  // offered either, so nothing points at a half-written bundle.
  const stored = row.status === "ready" ? row.exportUrl : null;
  return {
    exportId: row.id,
    status: row.status,
    ready: stored !== null,
    storageKey: stored === null ? null : exportObjectKey(stored),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
};
