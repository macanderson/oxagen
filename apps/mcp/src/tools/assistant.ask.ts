import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { assistantAsk } from "@oxagen/oxagen/contracts/assistant.ask";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...assistantAsk.input.shape };

export const metadata: ToolMetadata = {
  name: assistantAsk.name,
  description: assistantAsk.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function askAssistantTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(assistantAsk.name, args, ctx, { surface: "mcp" });
  return assistantAsk.output.parse(output);
}
