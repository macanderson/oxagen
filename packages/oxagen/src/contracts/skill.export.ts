import { z } from "zod";
import { registerCapability } from "../registry";

export const skillExport = registerCapability({
  name: "export_skill",
  domain: "skill",
  description:
    "Export the active or specified immutable skill version as canonical TOML",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    skillId: z.string().describe("Public ID of the skill (skl_…) or its slug"),
    versionNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Version number to export; defaults to the active version"),
  }),
  output: z.object({
    filename: z
      .string()
      .describe("Suggested filename for the download (e.g. my-skill.toml)"),
    content: z.string().describe("Canonical skill.toml content"),
    versionNumber: z
      .number()
      .int()
      .positive()
      .describe("Version number that was exported"),
  }),
});

export type SkillExportInput = z.output<typeof skillExport.input>;
export type SkillExportOutput = z.output<typeof skillExport.output>;
