import { z } from "zod";
import { registerCapability } from "../registry";

export const documentList = registerCapability({
  name: "document.list",
  domain: "document",
  description: "List documents in the workspace",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "document" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    workspace_id: z.string().optional(),
  }),
  output: z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        author: z.string(),
      }),
    ),
  }),
});

export type DocumentListInput = z.output<typeof documentList.input>;
export type DocumentListOutput = z.output<typeof documentList.output>;
