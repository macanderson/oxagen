import { z } from "zod";
import { registerCapability } from "../registry.js";

export const documentsGenerate = registerCapability({
  name: "documents.generate",
  domain: "documents",
  description:
    "Generate a new document, spreadsheet, or presentation via a cloud provider. " +
    "Optionally applies a brand kit to the created file. " +
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
    /** Cloud provider to create the document in. */
    provider: z.enum(["google", "microsoft"]),
    /** The kind of document to generate. */
    kind: z.enum(["document", "spreadsheet", "presentation"]),
    /** Title of the new document. */
    title: z.string().min(1),
    /** Optional natural-language instructions for content generation. */
    instructions: z.string().optional(),
    /** Optional brand-kit ID to apply to the created file. */
    brandKitId: z.string().optional(),
  }),
  output: z.object({
    stub: z.literal(true),
    provider: z.enum(["google", "microsoft"]),
    kind: z.enum(["document", "spreadsheet", "presentation"]),
    fileId: z.string(),
    url: z.string().url(),
  }),
});

export type DocumentsGenerateInput = z.output<typeof documentsGenerate.input>;
export type DocumentsGenerateOutput = z.output<typeof documentsGenerate.output>;
