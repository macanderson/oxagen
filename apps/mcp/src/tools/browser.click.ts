import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserClick } from "@oxagen/oxagen/contracts/browser.click";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserClick.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserClick.name,
  description: browserClick.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function browserClickTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserClick.name, args, ctx, { surface: "mcp" });
  return browserClick.output.parse(output);
}
