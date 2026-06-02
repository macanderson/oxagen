import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
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
