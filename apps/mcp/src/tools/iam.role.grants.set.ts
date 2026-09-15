import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...iamRoleGrantsSet.input.shape,
  roleId: iamRoleGrantsSet.input.shape.roleId.describe(
    "The custom role's public id (rol_…), from list_iam_roles",
  ),
  permissions: iamRoleGrantsSet.input.shape.permissions.describe(
    "The full permission set the role allows after the call; list_iam_roles returns the catalogue",
  ),
};

export const metadata: ToolMetadata = {
  name: iamRoleGrantsSet.name,
  description: iamRoleGrantsSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function setRoleGrantsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(iamRoleGrantsSet.name, args, ctx, {
    surface: "mcp",
  });
  return iamRoleGrantsSet.output.parse(output);
}
