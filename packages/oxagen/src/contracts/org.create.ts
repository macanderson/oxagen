import { z } from "zod";
import {
  ORG_TYPE_VALUES,
  INDUSTRY_VALUES,
  EMPLOYEE_SIZE_VALUES,
  isValidCountryCode,
  isValidUsStateCode,
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
  planSlug: z.string().min(1).default("free"),
  type: z.enum(ORG_TYPE_VALUES).default("business"),
  // Business-only fields — superRefine rejects these on personal accounts.
  website: z.string().trim().url().max(2048).optional(),
  industry: z.enum(INDUSTRY_VALUES).optional(),
  employeeSize: z.enum(EMPLOYEE_SIZE_VALUES).optional(),
  // Billing fields — present on both personal and business accounts.
  billingEmail: z.string().trim().email().max(320).optional(),
  billingAddress: z
    .object({
      line1: z.string().trim().min(1).max(255),
      line2: z.string().trim().max(255).optional(),
      city: z.string().trim().min(1).max(120),
      /**
       * Subdivision: an ISO 3166-2 code (e.g. "CA") — required and validated
       * as a US state/DC code when country is "US"; free-text region name for
       * non-US countries where we don't enumerate subdivisions.
       */
      region: z.string().trim().max(100).optional(),
      postalCode: z.string().trim().min(1).max(20),
      /** ISO 3166-1 alpha-2 code. Normalised to uppercase in the handler. */
      country: z.string().trim().length(2),
      /** Google Places place_id for address provenance tracking. */
      placeId: z.string().trim().max(255).optional(),
    })
    .optional(),
});

export const organizationCreate = registerCapability({
  name: "create_org",
  domain: "org",
  description: "Create a new organization with a globally-unique slug",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: false,
  agent: { requiresApproval: true, riskLevel: "medium", category: "organization" },
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
    // Billing address country + region validation.
    // Country is normalised to uppercase for comparison; actual storage-time
    // normalisation happens in the handler.
    if (data.billingAddress) {
      const countryUpper = data.billingAddress.country.toUpperCase();
      if (!isValidCountryCode(countryUpper)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${data.billingAddress.country}" is not a valid ISO 3166-1 alpha-2 country code`,
          path: ["billingAddress", "country"],
        });
      } else if (countryUpper === "US") {
        if (!data.billingAddress.region) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "State/region is required for US addresses",
            path: ["billingAddress", "region"],
          });
        } else if (!isValidUsStateCode(data.billingAddress.region)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${data.billingAddress.region}" is not a valid US state/DC code`,
            path: ["billingAddress", "region"],
          });
        }
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
export type OrganizationCreateOutput = z.output<typeof organizationCreate.output>;
