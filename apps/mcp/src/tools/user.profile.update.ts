import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userProfileUpdate } from "@oxagen/oxagen/contracts/user.profile.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...userProfileUpdate.input.shape };

export const metadata: ToolMetadata = {
  name: userProfileUpdate.name,
  description: userProfileUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function updateProfileTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userProfileUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return userProfileUpdate.output.parse(output);
}
