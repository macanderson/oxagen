// Stream-through proxy for access-controlled generated-asset serving.
//
// Mirrors the file-serving route: authorises the session user against the
// asset's access policy (serveGeneratedAsset handles the IDOR guard) and proxies
// the raw bytes from storage. The Vercel Blob URL is never exposed to the
// browser — generated images/videos serve from our own domain so the access
// policy (user/org/public) is actually enforced.

import { getSession } from "@/lib/session";
import {
  serveGeneratedAsset,
  GeneratedAssetNotFoundError,
  GeneratedAssetForbiddenError,
} from "@oxagen/handlers";

// Node runtime: the storage adapter uses Node.js crypto + the Vercel Blob SDK.
export const runtime = "nodejs";

// Never cache: every response is access-controlled; a stale cache entry could
// serve one user's private asset to another session.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const { assetId } = await ctx.params;

  const session = await getSession();
  // A logged-out request still gets served if the asset is public — but the
  // serve handler decides that. For non-public assets with no identity it
  // throws Forbidden → 404. Pass userId only when present.
  let out: Awaited<ReturnType<typeof serveGeneratedAsset>>;
  try {
    out = await serveGeneratedAsset(assetId, {
      userId: session?.user?.id,
      surface: "app",
    });
  } catch (err) {
    if (
      err instanceof GeneratedAssetNotFoundError ||
      err instanceof GeneratedAssetForbiddenError
    ) {
      // Both map to 404 — no leaking of asset existence via 403 vs 404.
      return new Response("Not Found", { status: 404 });
    }
    throw err;
  }

  const headers: Record<string, string> = {
    "content-type": out.mimeType,
    "cache-control": "private, max-age=0, must-revalidate",
    "content-disposition": out.contentDisposition,
    "x-content-type-options": "nosniff",
  };
  if (out.sizeBytes !== null) headers["content-length"] = out.sizeBytes.toString();

  return new Response(out.body, { status: 200, headers });
}
