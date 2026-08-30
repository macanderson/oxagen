import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgMemberAdd } from "@oxagen/oxagen/contracts/org.member.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgMemberAdd.input.shape,
  email: orgMemberAdd.input.shape.email.describe(
    "Email address of the user to invite",
  ),
  role: orgMemberAdd.input.shape.role.describe(
    "Org role to grant on acceptance (e.g. 'Admin', 'Member')",
  ),
};

export const metadata: ToolMetadata = {
  name: orgMemberAdd.name,
  description: orgMemberAdd.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function orgMemberAddTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgMemberAdd.name, args, ctx, { surface: "mcp" });
  return orgMemberAdd.output.parse(output);
}
