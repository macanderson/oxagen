import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { storage } from "@oxagen/storage";
import { getSession } from "@/lib/session";

// Avatar upload runs on the Node runtime (the storage adapter uses Node crypto
// and the Vercel Blob SDK) and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard limits. The client crops to a 512×512 webp (~tens of KB), so 5 MB is a
// generous ceiling that still blocks abuse. Only raster image types the cropper
// produces/accepts are allowed.
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * POST /api/v1/upload/avatar
 *
 * Accepts `multipart/form-data` with a single `file` field (the cropped image)
 * and stores it via the vendor-neutral storage adapter (Vercel Blob today).
 * Returns `{ url }` — the caller persists that URL onto the user (profile
 * action) or org (org settings action) after its own authorization checks.
 *
 * Auth: any signed-in user may upload. The object key is derived server-side
 * from the user id + a random UUID, so the client can never control the storage
 * path (no traversal / overwrite of another user's object).
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
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "Unsupported image type. Use PNG, JPEG, or WebP." },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image exceeds the 5 MB limit" }, { status: 413 });
  }

  // Server-derived key — user-controlled input never reaches the storage path.
  const key = `avatars/${session.user.id}/${randomUUID()}.${ext}`;

  try {
    const { url } = await storage().put({ key, body: file, contentType: file.type, access: "public" });
    return NextResponse.json({ url }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    // A missing BLOB token (misconfig) is an operator problem, not a client one.
    const status = message.includes("BLOB_READ_WRITE_TOKEN") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
