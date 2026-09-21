import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { configurationCloneGet } from "@oxagen/oxagen/contracts/configuration.clone.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = { ...configurationCloneGet.input.shape };
export const metadata: ToolMetadata = {
  name: configurationCloneGet.name,
  description: configurationCloneGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    configurationCloneGet.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return configurationCloneGet.output.parse(output);
}
