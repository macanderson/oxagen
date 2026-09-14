import { z } from "zod";
import {
  ORG_TYPE_VALUES,
  INDUSTRY_VALUES,
  EMPLOYEE_SIZE_VALUES,
} from "@oxagen/config";
import { registerCapability } from "../registry";

// Exported so MCP and other surfaces can spread `.shape` without re-declaring
// field constraints. The superRefine validation is layered on top below.
export const organizationCreateInputBase = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only"),
  // Organization creation is not a billing entitlement grant. Privileged plans
  // are established only through the canonical subscription lifecycle.
  planSlug: z.literal("free").default("free"),
  type: z.enum(ORG_TYPE_VALUES).default("business"),
  // Business-only fields — superRefine rejects these on personal accounts.
  website: z.string().trim().url().max(2048).optional(),
  industry: z.enum(INDUSTRY_VALUES).optional(),
  employeeSize: z.enum(EMPLOYEE_SIZE_VALUES).optional(),
  // Billing email/address were removed with billing.org_billing_profiles
  // (migration 20260802130000): the collected data was never read — Stripe
  // captures the billing address at checkout and is the source of truth.
});

export const organizationCreate = registerCapability({
  name: "create_org",
  domain: "org",
  description: "Create a new organization with a globally-unique slug",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: false,
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: organizationCreateInputBase.superRefine((data, ctx) => {
    // Business-only fields must be absent on personal accounts.
    if (data.type === "personal") {
      if (data.website !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "website is only valid for business accounts",
          path: ["website"],
        });
      }
      if (data.industry !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "industry is only valid for business accounts",
          path: ["industry"],
        });
      }
      if (data.employeeSize !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "employeeSize is only valid for business accounts",
          path: ["employeeSize"],
        });
      }
    }
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    type: z.string(),
    createdAt: z.string(),
  }),
});

export type OrganizationCreateInput = z.output<typeof organizationCreate.input>;
export type OrganizationCreateOutput = z.output<
  typeof organizationCreate.output
>;
