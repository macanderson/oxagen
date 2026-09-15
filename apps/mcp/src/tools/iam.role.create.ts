import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...iamRoleCreate.input.shape,
  name: iamRoleCreate.input.shape.name.describe(
    "Role name, immutable once created: lower-case, dot-separated, prefixed with the kind (agent., svc.)",
  ),
  permissions: iamRoleCreate.input.shape.permissions.describe(
    "Catalogue permission ids the role allows; list_iam_roles returns the catalogue",
  ),
};

export const metadata: ToolMetadata = {
  name: iamRoleCreate.name,
  description: iamRoleCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function createRoleTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(iamRoleCreate.name, args, ctx, {
    surface: "mcp",
  });
  return iamRoleCreate.output.parse(output);
}
