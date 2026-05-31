import { z } from "zod";
import { registerCapability } from "../registry.js";

export const documentsPdfCreate = registerCapability({
  name: "documents.pdf.create",
  domain: "documents",
  description:
    "Render a PDF from an HTML source or an existing cloud file. " +
    "Optionally applies a brand kit to the output. " +
    "Currently a console-logging stub — deferred backing.",
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
    /** Raw HTML markup to render into a PDF. */
    sourceHtml: z.string().optional(),
    /** Cloud file ID of a document to export as PDF. */
    sourceFileId: z.string().optional(),
    /** Optional brand-kit ID to apply to the PDF output. */
    brandKitId: z.string().optional(),
  }),
  output: z.object({
    stub: z.literal(true),
    fileId: z.string(),
    url: z.string().url(),
  }),
});

export type DocumentsPdfCreateInput = z.output<typeof documentsPdfCreate.input>;
export type DocumentsPdfCreateOutput = z.output<typeof documentsPdfCreate.output>;
