import { Hono } from "hono";
import { storage } from "@oxagen/storage";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

// Mounted at `/v1/:org_slug/:workspace_slug/privacy/export` (apps/api/src/app.ts),
// so the paths below are relative to that: a client calls
// `/v1/{org}/{workspace}/privacy/export/{exportId}/download`, tenant segments
// and all.
export const privacyDataExportRoute = new Hono<AppEnv>();

// POST /privacy/export — initiate an async export
privacyDataExportRoute.post("/", async (c) => {
  const body = privacyDataExport.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(privacyDataExport.name, body, ctx, {
    surface: "api",
  });
  return c.json(result, 202);
});

// GET /privacy/export/:exportId: poll export status.
//
// This read used to query privacy.privacy_export_requests here, outside
// invoke(), so it carried no IAM check, no audit row and no parity entry. It
// dispatches get_export_status now; the principal fence and the ready-only
// download link live in that handler.
privacyDataExportRoute.get("/:exportId", async (c) => {
  const body = privacyDataExportStatus.input.parse({
    exportId: c.req.param("exportId"),
  });
  const ctx = capabilityContext(c);
  const result = await invoke(privacyDataExportStatus.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});

// GET /privacy/export/:exportId/download: stream the archive itself.
//
// The status read answers with a storage key and no URL, because the bundle is
// a private object and the storage contract forbids rendering a private
// object's url in a browser. A key is no use to an API or CLI client either:
// reading it needs the store's credentials, which only the server holds. So
// the bytes are served here, the token-authenticated counterpart of the app's
// cookie-authenticated route.
//
// Authorization is the capability's, not this route's: get_export_status
// matches the row on the authenticated principal and the governed
// organisation, so an export that is not the caller's never reaches storage.
privacyDataExportRoute.get("/:exportId/download", async (c) => {
  const body = privacyDataExportStatus.input.parse({
    exportId: c.req.param("exportId"),
  });
  const ctx = capabilityContext(c);
  // Parsed through the contract's own output schema rather than asserted: the
  // route streams bytes off the back of this answer, so it reads the answer
  // the contract promises or it does not stream at all.
  const status = privacyDataExportStatus.output.parse(
    await invoke(privacyDataExportStatus.name, body, ctx, { surface: "api" }),
  );
  if (!status.ready || status.storageKey === null) {
    return c.json({ error: "not_ready", status: status.status }, 409);
  }
  const object = await storage().get(status.storageKey);
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.contentType ?? "application/zip",
      "content-disposition": `attachment; filename="oxagen-export-${body.exportId}.zip"`,
      // A data-subject export is never held by a shared cache.
      "cache-control": "private, no-store",
    },
  });
});
