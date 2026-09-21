import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = { ...configurationClonePropose.input.shape };
export const metadata: ToolMetadata = {
  name: configurationClonePropose.name,
  description: configurationClonePropose.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    configurationClonePropose.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return configurationClonePropose.output.parse(output);
}
