import { z } from "zod";
import { registerCapability } from "../registry";

export const imageCreate = registerCapability({
  name: "create_image",
  domain: "image",
  description:
    "Generate an image from a prompt and persist it as a workspace asset",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "generation" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    prompt: z.string().min(1),
    model: z.enum(["gpt-image-1", "flux-2-max"]).default("gpt-image-1"),
    size: z.string().optional(),
  }),
  output: z.object({
    image_id: z.string(),
    url: z.string(),
    created_at: z.string(),
  }),
});

export type ImageCreateInput = z.output<typeof imageCreate.input>;
export type ImageCreateOutput = z.output<typeof imageCreate.output>;
