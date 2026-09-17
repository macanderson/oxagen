import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { assistantEngineGet } from "@oxagen/oxagen/contracts/assistant.engine.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...assistantEngineGet.input.shape };

export const metadata: ToolMetadata = {
  name: assistantEngineGet.name,
  description: assistantEngineGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getAssistantEngineTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(assistantEngineGet.name, args, ctx, {
    surface: "mcp",
  });
  return assistantEngineGet.output.parse(output);
}
