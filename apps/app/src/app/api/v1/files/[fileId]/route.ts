// Stream-through proxy for access-controlled file serving.
//
// This route authorises the session user via org membership (serveFile handles
// the IDOR guard) and then proxies the raw bytes from storage. The Vercel Blob
// URL is never exposed to the browser — files always serve from our own domain.
//
// Avatars are OUT OF SCOPE: they remain public/direct via next/image.

import { getSession } from "@/lib/session";
import { serveFile, FileNotFoundError, FileForbiddenError } from "@oxagen/handlers";

// Node runtime required: the storage adapter uses Node.js crypto and the
// Vercel Blob SDK. Edge runtime does not provide the Node built-ins needed.
export const runtime = "nodejs";

// Never cache: every response is access-controlled; a stale cache entry
// would serve a prior user's file to a different session.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  // Next.js 16: params is an async Promise — must be awaited.
  ctx: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const { fileId } = await ctx.params;

  const session = await getSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  let out: Awaited<ReturnType<typeof serveFile>>;
  try {
    out = await serveFile(fileId, {
      userId: session.user.id,
      surface: "app",
    });
  } catch (err) {
    if (err instanceof FileNotFoundError || err instanceof FileForbiddenError) {
      // Both map to 404: no leaking of file existence via 403 vs 404
      // distinction (IDOR defence, mirrors the API surface behaviour).
      return new Response("Not Found", { status: 404 });
    }
    // Re-throw anything else (Next will render the error boundary).
    throw err;
  }

  return new Response(out.body, {
    status: 200,
    headers: {
      "content-type": out.mimeType,
      "content-length": out.sizeBytes.toString(),
      "cache-control": "private, max-age=0, must-revalidate",
      // Stored-XSS defence: never let the browser sniff a different type, and
      // force download for anything not on the render-safe allowlist (html,
      // svg, xml, …) since these bytes are served from our own origin.
      "content-disposition": out.contentDisposition,
      "x-content-type-options": "nosniff",
    },
  });
}
