import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { changeSetGet } from "@oxagen/oxagen/contracts/forge.changes.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...changeSetGet.input.shape };

export const metadata: ToolMetadata = {
  name: changeSetGet.name,
  description: changeSetGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function changeSetGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(changeSetGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(changeSetGet.output.parse(output));
}
