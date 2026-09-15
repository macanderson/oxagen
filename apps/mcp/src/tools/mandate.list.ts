import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = {
  ...mandateList.input.shape,
};

export const metadata: ToolMetadata = {
  name: mandateList.name,
  description: mandateList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function mandateListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateList.name, args, ctx, { surface: "mcp" });
  return mandateList.output.parse(output);
}
