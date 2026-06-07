import { z } from "zod";
import { registerCapability } from "../registry";

// Shared render directive emitted by every document-generation capability so
// the chat can render a file-attachment component without knowing the output
// kind. The `file-attachment` component is registered in the chat component
// registry by apps/app.
const fileRenderDirective = z.object({
  componentId: z.literal("file-attachment"),
  props: z.object({
    url: z.string(),
    name: z.string(),
    kind: z.enum(["document", "spreadsheet", "presentation"]),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
});

export const documentsGenerate = registerCapability({
  name: "documents.generate",
  domain: "documents",
  description:
    "Generate a DOCX document, XLSX spreadsheet, or PPTX presentation from structured content. " +
    "Files are built in-process (no cloud OAuth required), uploaded to blob storage, and served " +
    "through the access-controlled /api/v1/assets/<publicId> route.",
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
    /** The kind of document to generate. Drives the file format encoder. */
    kind: z.enum(["document", "spreadsheet", "presentation"]),
    /** Title of the new document / spreadsheet / presentation. */
    title: z.string().min(1),
    /** Structured content for the document. */
    content: z
      .object({
        /**
         * For documents: array of sections. Each section has a heading and body
         * paragraphs.
         */
        sections: z
          .array(
            z.object({
              heading: z.string().optional(),
              paragraphs: z.array(z.string()).min(1),
            }),
          )
          .optional(),
        /**
         * For spreadsheets: row data. `headers` are the column names; `rows`
         * is a 2-D array of cell values (string | number | boolean).
         */
        headers: z.array(z.string()).optional(),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).optional(),
        /**
         * For presentations: an array of slides. Each slide has a title and
         * optional bullet lines.
         */
        slides: z
          .array(
            z.object({
              title: z.string().min(1),
              bullets: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    /** Optional brand-kit colors to thread through the document. */
    brandColors: z
      .object({
        primary: z.string().optional(),
        secondary: z.string().optional(),
      })
      .optional(),
  }),
  output: z.object({
    assetId: z.string(),
    publicId: z.string(),
    kind: z.enum(["document", "spreadsheet", "presentation"]),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
    serveUrl: z.string(),
    render: fileRenderDirective,
  }),
});

export type DocumentsGenerateInput = z.output<typeof documentsGenerate.input>;
export type DocumentsGenerateOutput = z.output<typeof documentsGenerate.output>;
