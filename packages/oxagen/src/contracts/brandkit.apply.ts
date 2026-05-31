import { z } from "zod";
import { registerCapability } from "../registry.js";

export const brandkitApply = registerCapability({
  name: "brandkit.apply",
  domain: "brandkit",
  description:
    "Apply a workspace brand kit (colours, fonts, logos) to an existing cloud file. " +
    "Currently a console-logging stub — deferred backing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "brandkit",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** The workspace the brand kit belongs to. */
    workspaceId: z.string().min(1),
    /** ID of the brand kit to apply. */
    brandKitId: z.string().min(1),
    /** Cloud file ID of the target document. */
    targetFileId: z.string().min(1),
  }),
  output: z.object({
    stub: z.literal(true),
    /** Always false until the real backing is wired. */
    applied: z.literal(false),
    brandKitId: z.string(),
    targetFileId: z.string(),
  }),
});

export type BrandkitApplyInput = z.output<typeof brandkitApply.input>;
export type BrandkitApplyOutput = z.output<typeof brandkitApply.output>;
