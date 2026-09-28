import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  GeneratedAssetForbiddenError,
  GeneratedAssetNotFoundError,
  serveGeneratedAsset,
} from "@oxagen/handlers";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { assistantAttachmentIdSchema } from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read back a file a person attached to an assistant message, so a sent
 * message's card opens it (#4690, ADR-221).
 *
 * Only the person who uploaded the file reads it, and only inside the
 * organisation and workspace this route is scoped to. A missing file, one
 * that belongs to someone else, and one in another scope all answer the same
 * 404, so the answer does not say which files exist.
 */
export const assistantAttachmentGetRoute = new Hono<AppEnv>();

assistantAttachmentGetRoute.get("/:publicId", async (c) => {
  const parsed = assistantAttachmentIdSchema.safeParse(c.req.param("publicId"));
  if (!parsed.success) {
    throw new HTTPException(404, { message: "Attachment not found" });
  }
  const ctx = capabilityContext(c);
  const userId = await resolveActingUserId(ctx);
  if (!userId) {
    throw new HTTPException(404, { message: "Attachment not found" });
  }

  let out: Awaited<ReturnType<typeof serveGeneratedAsset>>;
  try {
    out = await serveGeneratedAsset(parsed.data, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId,
      surface: "api",
      requestId: c.get("requestId"),
    });
  } catch (err) {
    if (
      err instanceof GeneratedAssetNotFoundError ||
      err instanceof GeneratedAssetForbiddenError
    ) {
      throw new HTTPException(404, { message: "Attachment not found" });
    }
    throw err;
  }

  const headers: Record<string, string> = {
    "content-type": out.mimeType,
    "content-disposition": out.contentDisposition,
    // The file is one person's own: no shared cache keeps a copy, and the
    // browser treats the bytes as the type the server settled on.
    "cache-control": "private, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
  };
  if (out.sizeBytes !== null) headers["content-length"] = String(out.sizeBytes);
  return new Response(out.body, { headers });
});
