import { z } from "zod";
import { registerCapability } from "../registry";
import { publishedSkillConfigSchema, skillConfigSchema } from "../skills";

export const skillConfigGet = registerCapability({
  name: "get_skill_config",
  domain: "skill",
  mode: "sync",
  description:
    "Read the published skill resolution configuration and its immutable version history. A workspace with no imported configuration starts with skills off.",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ version: z.string().min(1).max(128).optional() }).strict(),
  output: z
    .object({
      config: skillConfigSchema,
      draftText: z.string(),
      current: publishedSkillConfigSchema.nullable(),
      versions: z.array(publishedSkillConfigSchema),
    })
    .strict(),
});
