import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserRead } from "@oxagen/oxagen/contracts/browser.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserRead.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserRead.name,
  description: browserRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function browserReadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserRead.name, args, ctx, { surface: "mcp" });
  return browserRead.output.parse(output);
}
