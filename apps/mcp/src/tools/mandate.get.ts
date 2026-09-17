import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = {
  ...mandateGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: mandateGet.name,
  description: mandateGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function mandateGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateGet.name, args, ctx, { surface: "mcp" });
  return mandateGet.output.parse(output);
}
