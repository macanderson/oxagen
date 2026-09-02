import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { promptSettingsRead } from "@oxagen/oxagen/contracts/prompt.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: promptSettingsRead.name,
  description: promptSettingsRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function promptSettingsReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(promptSettingsRead.name, {}, ctx, {
    surface: "mcp",
  });
  return promptSettingsRead.output.parse(output);
}
