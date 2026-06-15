import { z } from "zod";
import { registerCapability } from "../registry";

export const documentRead = registerCapability({
  name: "document.read",
  domain: "document",
  description: "Read a document by ID — returns title, content, and metadata",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "document" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    document_id: z.string(),
  }),
  output: z.object({
    title: z.string(),
    content: z.string(),
    metadata: z.record(z.unknown()),
    created_at: z.string(),
  }),
});

export type DocumentReadInput = z.output<typeof documentRead.input>;
export type DocumentReadOutput = z.output<typeof documentRead.output>;
