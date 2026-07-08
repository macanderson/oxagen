import { z } from "zod";
import { registerCapability } from "../registry";

// Ingest a binary asset from a source URL into object storage.
// The handler fetches the URL server-side (with SSRF protection), validates
// the content type and size, stores the object via the vendor-neutral storage
// adapter, and returns the CDN URL + canonical key.
export const assetUpload = registerCapability({
  name: "asset.upload",
  domain: "asset",
  description:
    "Ingest a binary asset from a source URL into object storage and return its stored URL and key.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "generation",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Publicly reachable URL of the asset to ingest. Must be http:// or https://. */
    sourceUrl: z.string().url(),
    /**
     * Asset category. Determines the allowed content types and size limit.
     * - "avatar": raster image (webp/png/jpeg), max 5 MiB.
     * - "image": raster image (webp/png/jpeg), max 5 MiB.
     * - "document": image or PDF, max 25 MiB.
     * - "video": mp4/webm/quicktime, max 100 MiB.
     */
    kind: z.enum(["avatar", "image", "document", "video"]),
    /**
     * Optional original filename. Used for display only — never influences
     * the storage path (which is always server-derived).
     */
    filename: z.string().min(1).max(200).optional(),
    /**
     * Attach-and-record semantics. Omit (default) for the legacy pure
     * blob-ingest behavior — no `generated_assets` row, matching the original
     * avatar/image/document callers exactly. Pass `"user_upload"` to
     * additionally record a `generated_assets` row (`source: "user_upload"`,
     * `prompt: ""`, `model: ""`, `accessPolicy: "org"`, private blob access)
     * so the asset appears in `conversation.files.list` and is servable via
     * the access-controlled `/api/v1/assets/:publicId` route.
     *
     * NOT supported for `kind: "avatar"` (avatars have no generated_assets
     * analog — they stay the pure public-blob profile-picture path) and
     * requires an authenticated user (not an API-key-only principal), since
     * `generated_assets.userId` is required for ownership.
     */
    source: z.enum(["user_upload"]).optional(),
    /**
     * Conversation to link the uploaded asset to (sets
     * `generated_assets.conversation_id`). Requires `source: "user_upload"`.
     */
    conversationId: z.string().min(1).optional(),
  }),
  output: z.object({
    /**
     * Access URL of the stored asset. For the legacy public path this is an
     * absolute public CDN URL. For `source: "user_upload"` this is the
     * relative, access-controlled serving path (`/api/v1/assets/:publicId`)
     * — the underlying blob is private and must never be exposed directly.
     */
    url: z.string().min(1),
    /** Canonical storage key (e.g. `image/org-123/uuid.webp`). */
    key: z.string().min(1),
    /** MIME type of the stored object. */
    contentType: z.string().min(1),
    /** Byte size of the stored object. */
    bytes: z.number().int().nonnegative(),
    /**
     * Public id (`gen_…`) of the `generated_assets` row created for this
     * upload. Null unless `source: "user_upload"` was requested.
     */
    publicId: z.string().nullable(),
  }),
});

export type AssetUploadInput = z.output<typeof assetUpload.input>;
export type AssetUploadOutput = z.output<typeof assetUpload.output>;
