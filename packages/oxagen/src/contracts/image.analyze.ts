import { z } from "zod";
import { registerCapability } from "../registry";

export const imageAnalyze = registerCapability({
  name: "analyze_image",
  domain: "image",
  description:
    "Analyze an image by ID — returns description, tags, and analysis",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "image" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    image_id: z.string(),
  }),
  output: z.object({
    analysis: z.string(),
    tags: z.array(z.string()),
    description: z.string(),
  }),
});

export type ImageAnalyzeInput = z.output<typeof imageAnalyze.input>;
export type ImageAnalyzeOutput = z.output<typeof imageAnalyze.output>;
