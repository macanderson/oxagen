import { z } from "zod";
import { registerCapability } from "../registry";

export const imageList = registerCapability({
  name: "image.list",
  domain: "image",
  description: "List images in the workspace",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "image" },
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
    images: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        created_at: z.string(),
        prompt: z.string(),
      }),
    ),
  }),
});

export type ImageListInput = z.output<typeof imageList.input>;
export type ImageListOutput = z.output<typeof imageList.output>;
