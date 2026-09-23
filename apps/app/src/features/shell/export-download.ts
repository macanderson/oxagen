// The authenticated download of a queued data export: `GET
// /{org}/account/export/{exportId}`.
//
// The archive is written as a PRIVATE object (`access: "private"` in
// `packages/inngest-functions/src/functions/privacy.export.process.ts`), and
// the storage contract is explicit that a private object's `url` is never
// rendered in a browser: on Vercel Blob it needs the store's read-write token,
// and on the filesystem driver it is a key rather than a route. So the tab
// links here instead, and the bytes are streamed server-side.
//
// Two gates, in order: the viewer must be signed in and a member of the org,
// and `get_export_status` must say the bundle is this person's and ready. The
// capability matches the row on the authenticated principal, so an id
// belonging to someone else answers `not_found` and never reaches storage.
//
// The bytes come in through `readObject`, the narrow reader `export-storage.ts`
// exports. This module holds no edge to `@oxagen/storage` of its own: the
// handler is the gate order, and which store the archive sits in is the seam's
// business, not the gate's.
import "server-only";
import type { ActionResult } from "@/server/kernel";
import { responseRedirect } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";
import type { RouteViewer } from "@/server/viewer";
import type { ExportObject } from "./export-storage";

export type ExportDownloadDeps = {
  resolveViewer: (org: string) => Promise<RouteViewer>;
  readStatus: (
    org: string,
    exportId: string,
  ) => Promise<ActionResult<{ ready: boolean; storageKey: string | null }>>;
  readObject: (key: string) => Promise<ExportObject>;
};

function refusal(status: number, code: string): Response {
  return Response.json({ code }, { status });
}

export async function handleExportDownload(
  request: Request,
  context: { params: Promise<{ org: string; exportId: string }> },
  deps: ExportDownloadDeps,
): Promise<Response> {
  const { org, exportId } = await context.params;
  const viewer = await deps.resolveViewer(org);
  switch (viewer.kind) {
    case "unauthenticated":
      return refusal(401, "unauthenticated");
    case "not_found":
      return refusal(404, "not_found");
    case "mfa_enroll":
      return refusal(403, "mfa_required");
    case "sso_required":
      return refusal(403, "sso_required");
    // The organization was reached by a slug it used to have. Falling through
    // to the read would spend the stale slug: `readStatus` resolves the viewer
    // a second time, and that resolution can only redirect through the
    // optional `x-url` / `next-url` headers. Without one it lands on the
    // canonical organization root, so the export id is dropped and the person
    // is handed a dashboard instead of their archive. Answer with the move
    // instead, the way the audit export route does.
    case "redirect":
      return responseRedirect(
        request,
        routes.accountExport(viewer.org, exportId),
        308,
      );
    case "ok":
      break;
  }

  const read = await deps.readStatus(org, exportId);
  if (!read.ok) {
    if (read.reason === "denied") return refusal(403, "denied");
    // An id that is not this person's is not_found, the same answer as an id
    // that does not exist: distinguishing them would say whether a stranger's
    // export id is real.
    if (read.reason === "not_found") return refusal(404, "not_found");
    // Everything else is the read failing, not the export missing. Postgres or
    // the kernel being down must not tell someone their archive is gone: a 404
    // is permanent and says do not come back, and the bundle is still there.
    return refusal(503, "unavailable");
  }
  // Still being written, or written and then failed. Either way there is
  // nothing to hand over yet.
  if (!read.value.ready || read.value.storageKey === null) {
    return refusal(409, "not_ready");
  }

  const object = await deps.readObject(read.value.storageKey);
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.contentType ?? "application/zip",
      "content-disposition": `attachment; filename="oxagen-export-${exportId}.zip"`,
      // A data-subject export is never cached by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}
