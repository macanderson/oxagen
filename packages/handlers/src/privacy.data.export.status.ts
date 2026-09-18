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
  const ready = row.status === "ready" && row.exportUrl !== null;
  return {
    exportId: row.id,
    status: row.status,
    ready,
    storageKey: ready ? row.exportUrl : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
};
