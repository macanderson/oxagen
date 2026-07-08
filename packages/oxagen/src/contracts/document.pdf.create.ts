import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive matching the file-attachment chat component.
const fileRenderDirective = z.object({
  componentId: z.literal("file-attachment"),
  props: z.object({
    url: z.string(),
    name: z.string(),
    kind: z.literal("pdf"),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
});

export const documentsPdfCreate = registerCapability({
  name: "create_pdf",
  aliases: ["document.pdf.create", "documents.pdf.create"],
  domain: "document",
  description:
    "Generate a PDF from a title and structured text content using pdf-lib. " +
    "The PDF is built in-process (pure JS, no Chromium), uploaded to blob storage, " +
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
    /** Title / filename of the output PDF. */
    title: z.string().min(1),
    /** Structured content sections rendered into the PDF. */
    content: z
      .object({
        sections: z
          .array(
            z.object({
              heading: z.string().optional(),
              paragraphs: z.array(z.string()).min(1),
            }),
          )
          .optional(),
      })
      .optional(),
    /** Optional brand colors. */
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
    kind: z.literal("pdf"),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
    serveUrl: z.string(),
    render: fileRenderDirective,
  }),
});

export type DocumentsPdfCreateInput = z.output<typeof documentsPdfCreate.input>;
export type DocumentsPdfCreateOutput = z.output<
  typeof documentsPdfCreate.output
>;
