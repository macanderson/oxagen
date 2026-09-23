import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoGroupRolesSet } from "@oxagen/oxagen/contracts/org.sso.group_roles.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const shape = orgSsoGroupRolesSet.input.shape;

export const schema = {
  providerId: shape.providerId.describe("The id of the provider"),
  mappings: shape.mappings.describe(
    "The whole table, up to 200 rows of { group, role }. group is the IdP group name exactly as sent; role is admin, compliance, billing or member. Rows not sent are removed",
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoGroupRolesSet.name,
  description: orgSsoGroupRolesSet.description,
  annotations: {
    readOnlyHint: false,
    // Replaces the whole table, so rows left out are removed.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function orgSsoGroupRolesSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoGroupRolesSet.name, args, ctx, {
    surface: "mcp",
  });
  return orgSsoGroupRolesSet.output.parse(output);
}
