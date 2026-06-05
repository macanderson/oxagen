import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  ORG_TYPE_VALUES,
  INDUSTRY_VALUES,
  EMPLOYEE_SIZE_VALUES,
} from "@oxagen/config";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  name: z.string().min(1).max(120).describe("Display name for the organization"),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only")
    .describe("URL-safe unique slug"),
  planSlug: z.string().min(1).default("free").describe("Initial plan slug"),
  type: z
    .enum(ORG_TYPE_VALUES)
    .default("business")
    .describe("Organization type. Use 'personal' for individual accounts, 'business' for teams and companies."),
  website: z
    .string()
    .trim()
    .url()
    .max(2048)
    .optional()
    .describe("Business website URL (business type only)"),
  industry: z
    .enum(INDUSTRY_VALUES)
    .optional()
    .describe("Industry sector slug (business type only; e.g. 'software-it', 'healthcare')"),
  employeeSize: z
    .enum(EMPLOYEE_SIZE_VALUES)
    .optional()
    .describe("Employee size range slug (business type only; e.g. '2-10', '51-200')"),
  billingEmail: z
    .string()
    .trim()
    .email()
    .max(320)
    .optional()
    .describe("Billing contact email address"),
  billingAddress: z
    .object({
      line1: z.string().trim().min(1).max(255).describe("Street address line 1"),
      line2: z.string().trim().max(255).optional().describe("Street address line 2 (suite, floor, etc.)"),
      city: z.string().trim().min(1).max(120).describe("City"),
      region: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe("ISO 3166-2 subdivision code (2-letter US state required when country is US; e.g. 'CA')"),
      postalCode: z.string().trim().min(1).max(20).describe("Postal or ZIP code"),
      country: z
        .string()
        .trim()
        .length(2)
        .describe("ISO 3166-1 alpha-2 country code, uppercase (e.g. 'US', 'GB')"),
      placeId: z
        .string()
        .trim()
        .max(255)
        .optional()
        .describe("Google Places place_id for address provenance"),
    })
    .optional()
    .describe("Billing address. Country and region are ISO standard codes."),
};

export const metadata: ToolMetadata = {
  name: organizationCreate.name,
  description: organizationCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function organizationCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(organizationCreate.name, args, ctx, { surface: "mcp" });
  return organizationCreate.output.parse(output);
}
