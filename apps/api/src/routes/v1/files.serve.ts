import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveFile, FileNotFoundError, FileForbiddenError } from "@oxagen/handlers";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const filesServeRoute = new Hono<AppEnv>();

/**
 * GET /v1/:org_slug/:workspace_slug/files/:file_id
 *
 * Stream-through proxy for access-controlled file serving. The response
 * body is the raw object bytes; the vendor (Vercel Blob) URL is never
 * exposed to the caller.
 *
 * Auth:  org + workspace scope (enforced by orgMiddleware + workspaceMiddleware
 *        before this route is reached).
 * Cache: private, must-revalidate — every request is authorised; CDN caching
 *        of access-controlled responses is intentionally disabled.
 */
filesServeRoute.get("/:file_id", async (c) => {
  const fileId = c.req.param("file_id");
  const ctx = capabilityContext(c);

  let out: Awaited<ReturnType<typeof serveFile>>;
  try {
    out = await serveFile(fileId, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId ?? undefined,
      surface: "api",
      requestId: ctx.requestId,
    });
  } catch (err) {
    if (err instanceof FileNotFoundError || err instanceof FileForbiddenError) {
      // Both map to 404: we must not leak file existence to the caller via a
      // 403 vs 404 distinction (IDOR defence).
      throw new HTTPException(404, { message: "File not found" });
    }
    throw err;
  }

  return new Response(out.body, {
    status: 200,
    headers: {
      "content-type": out.mimeType,
      "content-length": out.sizeBytes.toString(),
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
});
