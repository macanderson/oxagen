import { NextResponse } from "next/server";
import {
  ASSET_LIMITS,
  assertAllowedAssetType,
  deriveAssetKey,
  storage,
} from "@oxagen/storage";
import { getSession } from "@/lib/session";

// Avatar upload runs on the default Node.js runtime (the storage adapter uses
// Node crypto and the Vercel Blob SDK) and must never move to edge. No
// `export const runtime` — the segment config is incompatible with
// cacheComponents; Node is the framework default.

/**
 * POST /api/v1/upload/avatar
 *
 * Accepts `multipart/form-data` with a single `file` field (the cropped image)
 * and stores it via the vendor-neutral storage adapter (Vercel Blob today).
 * Returns `{ url }` — the caller persists that URL onto the user (profile
 * action) or org (org settings action) after its own authorization checks.
 *
 * Auth: any signed-in user may upload. The object key is derived server-side
 * from the user id + a random UUID via `deriveAssetKey`, so the client can
 * never control the storage path (no traversal / overwrite of another user's
 * object).
 *
 * Limits and allowed types come from `@oxagen/storage` (ASSET_LIMITS,
 * assertAllowedAssetType) — the single source of truth shared with the
 * asset.upload capability handler.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  let ext: string;
  try {
    ext = assertAllowedAssetType("avatar", file.type);
  } catch {
    return NextResponse.json(
      { error: "Unsupported image type. Use PNG, JPEG, or WebP." },
      { status: 415 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (file.size > ASSET_LIMITS.avatar) {
    return NextResponse.json(
      { error: "Image exceeds the 5 MB limit" },
      { status: 413 },
    );
  }

  // Server-derived key — user-controlled input never reaches the storage path.
  const key = deriveAssetKey("avatar", session.user.id, ext);

  try {
    const { url } = await storage().put({
      key,
      body: file,
      contentType: file.type,
      access: "public",
    });
    return NextResponse.json({ url }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    // A missing BLOB token (misconfig) is an operator problem, not a client one.
    const status = message.includes("BLOB_READ_WRITE_TOKEN") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
