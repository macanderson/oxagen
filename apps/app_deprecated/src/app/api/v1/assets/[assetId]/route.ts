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

// Default Node.js runtime: the storage adapter uses Node.js crypto + the Vercel
// Blob SDK — never move to edge. No `export const runtime` (incompatible with
// cacheComponents; Node is the framework default).

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
      // Both map to 404 — no leaking of asset existence via 403 vs 404. An
      // absent / wrong-type id (e.g. an agent `agt_…` mistakenly used as an
      // asset id) has no `generated_assets` row, so it lands here as a clean
      // 404 — never an unhandled error and never the API's "Organization not
      // found" JSON.
      return new Response("Not Found", { status: 404 });
    }
    // Any UNEXPECTED failure (storage outage, db error) is returned as a plain
    // 500 — this route is consumed by <img src>/<a href>, so it must never
    // bubble an unhandled throw (which could render a framework error page or a
    // raw JSON body in place of the asset).
    console.error("asset.serve route: unexpected error", {
      assetId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Internal Server Error", { status: 500 });
  }

  const headers: Record<string, string> = {
    "content-type": out.mimeType,
    "cache-control": "private, max-age=0, must-revalidate",
    "content-disposition": out.contentDisposition,
    "x-content-type-options": "nosniff",
  };
  if (out.sizeBytes !== null)
    headers["content-length"] = out.sizeBytes.toString();

  return new Response(out.body, { status: 200, headers });
}
