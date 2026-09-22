// GET /v1/run-exports/download?token=… streams a ready run export bundle to
// whoever holds a download URL from `get_run_export` (spec §13.4, ADR-058).
//
// No session: the person verifying a bundle is often an outside auditor. The
// signed token is the boundary. It names the export, its tenant and the
// bundle digest, and it expires. Every refusal is one 404 so a probe learns
// nothing about which part failed. The bundle is read inside the token's
// tenant scope, and the response names its digest so a client can check the
// bytes it received.
import { Hono } from "hono";
import { schema, withTenantDb } from "@oxagen/database";
import {
  openRunExportDownload,
  type OpenRunExportDownloadDeps,
  runExportDownloadSecret,
} from "@oxagen/handlers/lib/run-export-download";
import { storage } from "@oxagen/storage";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../app";

const defaultDeps: OpenRunExportDownloadDeps = {
  secret: runExportDownloadSecret,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  readRow: (claims) =>
    runInTenantScope(
      { orgId: claims.orgId, workspaceId: claims.workspaceId },
      async () => {
        const t = schema.runExports;
        const [row] = await withTenantDb((tx) =>
          tx
            .select({
              runPublicId: t.runPublicId,
              status: t.status,
              bundleRef: t.bundleRef,
              bundleDigest: t.bundleDigest,
              bundleBytes: t.bundleBytes,
            })
            .from(t)
            .where(
              and(
                eq(t.publicId, claims.exportId),
                eq(t.orgId, claims.orgId),
                eq(t.workspaceId, claims.workspaceId),
              ),
            )
            .limit(1),
        );
        return row ?? null;
      },
    ),
  getObject: (ref) => storage().get(ref),
};

export function createRunExportDownloadRoute(
  deps: OpenRunExportDownloadDeps = defaultDeps,
): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/", async (c) => {
    const token = c.req.query("token");
    const opened = token ? await openRunExportDownload(token, deps) : null;
    if (!opened) {
      return c.json({ error: "not_found" }, 404, {
        "Cache-Control": "no-store",
      });
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${opened.filename}"`,
      "Cache-Control": "no-store",
      "X-Bundle-Digest": opened.bundleDigest,
    };
    if (opened.bytes !== null) headers["Content-Length"] = String(opened.bytes);
    return new Response(opened.body, { status: 200, headers });
  });
  return route;
}

export const runExportDownloadRoute = createRunExportDownloadRoute();
