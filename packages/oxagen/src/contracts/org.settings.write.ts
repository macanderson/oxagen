import { z } from "zod";
import { registerCapability } from "../registry";
import { ORG_EMPLOYEE_SIZES } from "./org.settings.read";

// Partial update of the organization profile. Every field is optional:
//   omit  = leave unchanged
//   value = set
//   null  = clear (only the nullable profile fields accept null)
export const orgSettingsWrite = registerCapability({
  name: "update_org_settings",
  domain: "org",
  description:
    "Update the active organization's profile settings (partial): name, slug, avatar, website, industry, and employee size. Routes the settings page edit through the kernel so the same fields are reachable from the agent, MCP, and CLI with metering + audit.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    name: z.string().min(1).max(120).trim().optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must be lowercase letters, numbers, and single hyphens",
      )
      .optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
    website: z.string().url().max(2048).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    employeeSize: z.enum(ORG_EMPLOYEE_SIZES).nullable().optional(),
  }),
  output: z.object({
    name: z.string(),
    slug: z.string(),
    avatarUrl: z.string().nullable(),
    website: z.string().nullable(),
    industry: z.string().nullable(),
    employeeSize: z.enum(ORG_EMPLOYEE_SIZES).nullable(),
    type: z.enum(["personal", "business"]),
  }),
});

export type OrgSettingsWriteInput = z.output<typeof orgSettingsWrite.input>;
export type OrgSettingsWriteOutput = z.output<typeof orgSettingsWrite.output>;
