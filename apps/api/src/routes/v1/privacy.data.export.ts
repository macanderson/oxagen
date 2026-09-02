import { Hono } from "hono";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
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

// GET /privacy/export/:exportId — poll export status
privacyDataExportRoute.get("/:exportId", async (c) => {
  const exportId = c.req.param("exportId");
  const ctx = capabilityContext(c);
  const userId = ctx.userId;
  if (!userId) return c.json({ error: "unauthorized" }, 401);
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
          eq(schema.privacyExportRequests.id, exportId),
          eq(schema.privacyExportRequests.userId, userId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({
    exportId: row.id,
    status: row.status,
    downloadUrl: row.exportUrl ?? undefined,
  });
});
