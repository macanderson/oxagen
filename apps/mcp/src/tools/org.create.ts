import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  organizationCreate,
  organizationCreateInputBase,
} from "@oxagen/oxagen/contracts/org.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...organizationCreateInputBase.shape,
  name: organizationCreateInputBase.shape.name.describe(
    "Display name for the organization",
  ),
  slug: organizationCreateInputBase.shape.slug.describe("URL-safe unique slug"),
  planSlug: organizationCreateInputBase.shape.planSlug.describe(
    "Initial plan slug; organization creation always starts on free",
  ),
  type: organizationCreateInputBase.shape.type.describe(
    "Organization type. Use 'personal' for individual accounts, 'business' for teams and companies.",
  ),
  website: organizationCreateInputBase.shape.website.describe(
    "Business website URL (business type only)",
  ),
  industry: organizationCreateInputBase.shape.industry.describe(
    "Industry sector slug (business type only; e.g. 'software-it', 'healthcare')",
  ),
  employeeSize: organizationCreateInputBase.shape.employeeSize.describe(
    "Employee size range slug (business type only; e.g. '2-10', '51-200')",
  ),
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
  const output = await invoke(organizationCreate.name, args, ctx, {
    surface: "mcp",
  });
  return organizationCreate.output.parse(output);
}
