import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive matching the file-attachment chat component.
const fileRenderDirective = z.object({
  componentId: z.literal("file-attachment"),
  props: z.object({
    url: z.string(),
    name: z.string(),
    kind: z.literal("archive"),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
});

export const archiveCreate = registerCapability({
  name: "create_archive",
  domain: "document",
  description:
    "Bundle one or more items — existing generated assets, inline base64 blobs, or plain text — " +
    "into a ZIP archive. The archive is built in-process with fflate, uploaded to blob storage, " +
    "and served through the access-controlled /api/v1/assets/<publicId> route.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "documents",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Desired filename of the ZIP archive (without extension). */
    archiveName: z.string().min(1).default("archive"),
    /**
     * Entries to bundle. At least one entry is required. Provide exactly one of:
     *   - `assetId`: publicId of an existing generated asset to fetch from storage
     *   - `contentBase64`: raw bytes encoded as base64
     *   - `text`: UTF-8 string to encode
     */
    entries: z
      .array(
        z.object({
          /** Filename inside the ZIP (including extension). */
          name: z.string().min(1),
          /** publicId ("gen_…") of an existing generated asset. */
          assetId: z.string().optional(),
          /** Raw bytes as a base64 string. */
          contentBase64: z.string().optional(),
          /** UTF-8 text content. */
          text: z.string().optional(),
        }),
      )
      .min(1, "At least one entry is required")
      // Capacity guard: the handler resolves every entry concurrently, holds
      // all bytes in memory, and zips synchronously — an unbounded array is a
      // memory/event-loop DoS vector for a single authed request.
      .max(100, "At most 100 entries per archive"),
  }),
  output: z.object({
    assetId: z.string(),
    publicId: z.string(),
    kind: z.literal("archive"),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
    serveUrl: z.string(),
    render: fileRenderDirective,
  }),
});

export type ArchiveCreateInput = z.output<typeof archiveCreate.input>;
export type ArchiveCreateOutput = z.output<typeof archiveCreate.output>;
