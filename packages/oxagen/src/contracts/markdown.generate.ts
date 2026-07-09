import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive emitted by markdown.generate so the chat can render a
// file-attachment component without needing to know the output kind. The
// `file-attachment` component is registered in the chat component registry by
// apps/app and is shared with documents.generate / documents.pdf.create.
const fileRenderDirective = z.object({
  componentId: z.literal("file-attachment"),
  props: z.object({
    url: z.string(),
    name: z.string(),
    kind: z.literal("markdown"),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
});

export const markdownGenerate = registerCapability({
  name: "generate_markdown",
  domain: "document",
  description:
    "Persist a Markdown document as a first-class generated asset. " +
    "Raw Markdown source is encoded to UTF-8 bytes, uploaded to blob storage, " +
    "and served through the access-controlled /api/v1/assets/<publicId> route. " +
    "No cloud OAuth required — the operation is fully in-process.",
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
    /** Title / filename (without extension) of the output Markdown document. */
    title: z.string().min(1),
    /**
     * Raw Markdown source. When provided, this is used verbatim. An optional
     * `sections` fallback allows structured input when the caller does not have
     * pre-rendered Markdown (the handler will assemble a simple heading + body
     * Markdown string from the sections).
     */
    markdown: z.string().optional(),
    /**
     * Structured sections fallback. Used only when `markdown` is absent.
     * Each section emits an H2 heading (if present) followed by paragraphs.
     */
    sections: z
      .array(
        z.object({
          heading: z.string().optional(),
          paragraphs: z.array(z.string()).min(1),
        }),
      )
      .optional(),
  }),
  output: z.object({
    assetId: z.string(),
    publicId: z.string(),
    kind: z.literal("markdown"),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
    serveUrl: z.string(),
    render: fileRenderDirective,
  }),
});

export type MarkdownGenerateInput = z.output<typeof markdownGenerate.input>;
export type MarkdownGenerateOutput = z.output<typeof markdownGenerate.output>;
