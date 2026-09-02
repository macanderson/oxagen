import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...iamRoleList.input.shape,
};

export const metadata: ToolMetadata = {
  name: iamRoleList.name,
  description: iamRoleList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function iamRoleListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(iamRoleList.name, args, ctx, { surface: "mcp" });
  return iamRoleList.output.parse(output);
}
