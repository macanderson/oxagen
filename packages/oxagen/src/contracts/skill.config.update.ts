import { z } from "zod";
import { registerCapability } from "../registry";
import { publishedSkillConfigSchema } from "../skills";

export const skillConfigUpdate = registerCapability({
  name: "update_skill_config",
  domain: "skill",
  mode: "sync",
  description:
    "Propose skill configuration in a pull request, import the existing approved repository configuration once, or publish a merged configuration pull request after reading back its commit.",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "configuration",
  },
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      action: z.enum(["propose", "publish", "import"]),
      text: z.string().min(1).max(200_000).optional(),
      pullRequestNumber: z.number().int().positive().optional(),
    })
    .strict(),
  output: z
    .object({
      pullRequest: z
        .object({ number: z.number().int().positive(), url: z.string() })
        .strict()
        .nullable(),
      published: publishedSkillConfigSchema.nullable(),
    })
    .strict(),
});
