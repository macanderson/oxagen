import { Hono } from "hono";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

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

// GET /privacy/export/:exportId — poll export status.
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
