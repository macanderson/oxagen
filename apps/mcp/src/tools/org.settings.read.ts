import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSettingsRead } from "@oxagen/oxagen/contracts/org.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {};

export const metadata: ToolMetadata = {
  name: orgSettingsRead.name,
  description: orgSettingsRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSettingsReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSettingsRead.name, {}, ctx, {
    surface: "mcp",
  });
  return toolResult(orgSettingsRead.output.parse(output));
}
