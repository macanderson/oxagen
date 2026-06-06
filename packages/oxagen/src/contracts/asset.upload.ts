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
     */
    kind: z.enum(["avatar", "image", "document"]),
    /**
     * Optional original filename. Used for display only — never influences
     * the storage path (which is always server-derived).
     */
    filename: z.string().min(1).max(200).optional(),
  }),
  output: z.object({
    /** Public CDN URL of the stored asset. */
    url: z.string().url(),
    /** Canonical storage key (e.g. `image/org-123/uuid.webp`). */
    key: z.string().min(1),
    /** MIME type of the stored object. */
    contentType: z.string().min(1),
    /** Byte size of the stored object. */
    bytes: z.number().int().nonnegative(),
  }),
});

export type AssetUploadInput = z.output<typeof assetUpload.input>;
export type AssetUploadOutput = z.output<typeof assetUpload.output>;
