import { z } from "zod";
import { registerCapability } from "../registry";

export const documentCreate = registerCapability({
  name: "document.create",
  domain: "document",
  description: "Create a new document in the workspace",
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
    title: z.string().min(1),
    content: z.string().optional(),
  }),
  output: z.object({
    document_id: z.string(),
    title: z.string(),
    created_at: z.string(),
    workspace_id: z.string(),
  }),
});

export type DocumentCreateInput = z.output<typeof documentCreate.input>;
export type DocumentCreateOutput = z.output<typeof documentCreate.output>;
