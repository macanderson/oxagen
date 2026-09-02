import { z } from "zod";
import { registerCapability } from "../registry";

// Closed employee-size range slugs — mirrors the organizations_employee_size_check
// CHECK constraint in the org schema. NULL on personal orgs / unset.
export const ORG_EMPLOYEE_SIZES = [
  "1",
  "2-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10000+",
] as const;

const orgSettingsOutput = z.object({
  name: z.string(),
  slug: z.string(),
  avatarUrl: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  employeeSize: z.enum(ORG_EMPLOYEE_SIZES).nullable(),
  type: z.enum(["personal", "business"]),
});

export const orgSettingsRead = registerCapability({
  name: "get_org_settings",
  domain: "org",
  description:
    "Read the active organization's profile settings: name, slug, avatar, website, industry, employee size, and type.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "organization",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: orgSettingsOutput,
});

export type OrgSettingsReadOutput = z.output<typeof orgSettingsRead.output>;
