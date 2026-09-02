import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { promptSettingsWrite } from "@oxagen/oxagen/contracts/prompt.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...promptSettingsWrite.input.shape,
};

export const metadata: ToolMetadata = {
  name: promptSettingsWrite.name,
  description: promptSettingsWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function promptSettingsWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(promptSettingsWrite.name, args, ctx, {
    surface: "mcp",
  });
  return promptSettingsWrite.output.parse(output);
}
