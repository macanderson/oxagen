import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSettingsWrite } from "@oxagen/oxagen/contracts/org.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgSettingsWrite.input.shape,
};

export const metadata: ToolMetadata = {
  name: orgSettingsWrite.name,
  description: orgSettingsWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSettingsWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSettingsWrite.name, args, ctx, {
    surface: "mcp",
  });
  return orgSettingsWrite.output.parse(output);
}
