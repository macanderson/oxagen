import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...iamRoleDelete.input.shape,
  roleId: iamRoleDelete.input.shape.roleId.describe(
    "The custom role's public id (rol_…), from list_iam_roles",
  ),
};

export const metadata: ToolMetadata = {
  name: iamRoleDelete.name,
  description: iamRoleDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function deleteRoleTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(iamRoleDelete.name, args, ctx, {
    surface: "mcp",
  });
  return iamRoleDelete.output.parse(output);
}
