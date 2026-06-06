// file.serve.ts — vendor-portable, access-controlled file streaming.
//
// This is NOT a capability handler (not registered in the kernel / invoke()
// path) because file serving is raw data access, not an AI capability. It
// lives in packages/handlers so the authz + telemetry logic is shared
// identically by both apps/api and apps/app — no drift, no duplication.
//
// Authz decision table:
//
//   surface | principal fields set        | check                                                         | deny outcome
//   --------|-----------------------------|---------------------------------------------------------------|-------------
//   api     | orgId (always)              | file.orgId === principal.orgId                                | notFound
//   api     | orgId + workspaceId         | above + file.workspaceId === principal.workspaceId            | notFound
//   app     | userId                      | org_users row exists for (file.orgId, userId)                 | notFound
//   any     | neither orgId nor userId    | reject immediately                                            | forbidden
//
// Using notFound (not forbidden) in all authz-failure paths is deliberate:
// a non-member must not be able to confirm a file's existence via a
// 403 vs 404 difference (IDOR defence, same pattern as assertOrgMember).

import { eq, and } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import { storage, StorageNotFoundError } from "@oxagen/storage";
import { insertEvents } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

// ── Typed error classes ───────────────────────────────────────────────────────

/**
 * Thrown when the requested file does not exist in the database, the caller
 * is not authorised to access it, or the underlying storage object is absent.
 * All three cases surface identically (HTTP 404) to prevent leaking existence
 * information via error discrimination.
 */
export class FileNotFoundError extends Error {
  readonly notFound = true as const;
  constructor(fileId: string) {
    super(`File not found: ${fileId}`);
    this.name = "FileNotFoundError";
  }
}

/**
 * Thrown when no principal identity is available at all (no orgId, no userId).
 * The API route maps this to a 404 as well (to match notFound semantics and
 * avoid leaking resource existence), though the root cause is missing auth.
 */
export class FileForbiddenError extends Error {
  readonly forbidden = true as const;
  constructor() {
    super("Insufficient credentials to serve file");
    this.name = "FileForbiddenError";
  }
}

// ── Public types ─────────────────────────────────────────────────────────────

/** Identity context injected by the calling surface. */
export interface FileServePrincipal {
  /** Present on the api surface (pre-bound by the API-key middleware). */
  orgId?: string;
  /** Present on the api surface when the key is workspace-scoped. */
  workspaceId?: string;
  /** Present on the app surface (session userId). */
  userId?: string;
  /** Origin surface, used for telemetry. */
  surface: "api" | "app";
  /** Request correlation ID, attached to the telemetry event when present. */
  requestId?: string;
}

/** Resolved streaming result returned to the route handler. */
export interface FileServeResult {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  sizeBytes: bigint;
  /**
   * Safe `Content-Disposition` value the route MUST set on the response.
   * `inline` only for a vetted allowlist of render-safe types; `attachment`
   * for everything else. Forcing download on active types (html, svg, xml…)
   * neutralises stored-XSS: a user-uploaded file is served from our own
   * authenticated origin, so an inline-rendered script would run in-origin.
   */
  contentDisposition: "inline" | "attachment";
}

/** Content types that are safe to render inline in the browser. */
const INLINE_SAFE_TYPES = new Set(["application/pdf", "text/plain"]);

/**
 * Decide whether a stored object may be served `inline` or must be forced to
 * `attachment`. SVG is explicitly excluded from the image allowlist because it
 * can carry script. The default is the safe one (`attachment`).
 */
function safeContentDisposition(mimeType: string): "inline" | "attachment" {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "inline";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "inline";
  if (INLINE_SAFE_TYPES.has(type)) return "inline";
  return "attachment";
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Authorise and stream a file identified by its `publicId` (e.g. `fil_…`).
 *
 * @throws {FileForbiddenError} When no usable identity is present.
 * @throws {FileNotFoundError}  When the file is absent, the caller is not
 *   authorised, or the storage object is missing.
 */
export async function serveFile(
  fileId: string,
  principal: FileServePrincipal,
): Promise<FileServeResult> {
  // ── 1. Load the file row ─────────────────────────────────────────────────
  // tenancy: unscoped seam (not a kernel capability — called directly from the
  // route layer without a kernel invocation; no ALS tenant scope is present;
  // authz is enforced via the principal's orgId/userId fields below) — OXA-1515
  const rows = await db()
    .select()
    .from(schema.files)
    .where(eq(schema.files.publicId, fileId))
    .limit(1);

  const file = rows[0];
  if (!file) {
    logger.warn({ fileId, surface: principal.surface }, "file.serve: file not found in db");
    throw new FileNotFoundError(fileId);
  }

  // ── 2. Authorisation ─────────────────────────────────────────────────────
  if (principal.orgId) {
    // API surface: org scope is pre-bound by the auth middleware; we only
    // need to verify the file belongs to the same org (and workspace, if
    // the key is workspace-scoped). Return notFound on mismatch so a
    // cross-org file ID does not confirm its existence.
    if (file.orgId !== principal.orgId) {
      logger.warn(
        { fileId, fileOrgId: file.orgId, principalOrgId: principal.orgId, surface: "api" },
        "file.serve: org mismatch — access denied",
      );
      throw new FileNotFoundError(fileId);
    }
    if (principal.workspaceId && file.workspaceId !== principal.workspaceId) {
      logger.warn(
        { fileId, fileWorkspaceId: file.workspaceId, principalWorkspaceId: principal.workspaceId, surface: "api" },
        "file.serve: workspace mismatch — access denied",
      );
      throw new FileNotFoundError(fileId);
    }
  } else if (principal.userId) {
    // App surface: verify the session user is a member of the file's org.
    // Direct query (not imported from apps/app) — same logic as
    // assertOrgMember() in resolve-org.ts, replicated here to keep
    // packages/handlers free of app-layer imports.
    // tenancy: unscoped seam (same as above — no kernel scope) — OXA-1515
    const membership = await db()
      .select({ id: schema.orgUsers.id })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, file.orgId),
          eq(schema.orgUsers.userId, principal.userId),
        ),
      )
      .limit(1);

    if (membership.length === 0) {
      logger.warn(
        { fileId, fileOrgId: file.orgId, userId: principal.userId, surface: "app" },
        "file.serve: user is not a member of the file's org — access denied",
      );
      throw new FileNotFoundError(fileId);
    }
  } else {
    // No usable identity — reject before touching storage.
    logger.warn({ fileId, surface: principal.surface }, "file.serve: no identity principal");
    throw new FileForbiddenError();
  }

  // ── 3. Fetch from storage ────────────────────────────────────────────────
  let obj: Awaited<ReturnType<ReturnType<typeof storage>["get"]>>;
  try {
    obj = await storage().get(file.storageKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      // Storage object is absent (e.g. orphaned DB row after a failed upload
      // or a manual deletion from the bucket). Surface as 404.
      logger.error(
        { fileId, storageKey: file.storageKey, surface: principal.surface },
        "file.serve: storage object missing for file row",
      );
      throw new FileNotFoundError(fileId);
    }
    throw err;
  }

  // ── 4. Fire-and-forget telemetry ─────────────────────────────────────────
  // Wrapped in a void-returning IIFE so it never blocks or breaks the response.
  // We intentionally do NOT await this — streaming starts immediately.
  void (async () => {
    try {
      await insertEvents([
        {
          event_id: randomUUID(),
          org_id: file.orgId,
          workspace_id: file.workspaceId,
          event_type: "file.served",
          source_system: principal.surface,
          stream_offset: null,
          payload: JSON.stringify({
            fileId,
            sizeBytes: file.sizeBytes.toString(),
            mimeType: file.mimeType,
            ...(principal.requestId ? { requestId: principal.requestId } : {}),
          }),
          emitted_at: new Date().toISOString(),
        },
      ]);
    } catch (telemetryErr) {
      // Telemetry must never affect the response path.
      logger.warn(
        { fileId, surface: principal.surface, err: telemetryErr },
        "file.serve: telemetry insert failed (non-fatal)",
      );
    }
  })();

  return {
    body: obj.body,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentDisposition: safeContentDisposition(file.mimeType),
  };
}
