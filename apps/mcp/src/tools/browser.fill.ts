import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserFill } from "@oxagen/oxagen/contracts/browser.fill";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserFill.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserFill.name,
  description: browserFill.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function browserFillTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserFill.name, args, ctx, { surface: "mcp" });
  return browserFill.output.parse(output);
}
