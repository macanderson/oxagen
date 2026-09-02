import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserNavigate } from "@oxagen/oxagen/contracts/browser.navigate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserNavigate.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserNavigate.name,
  description: browserNavigate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function browserNavigateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserNavigate.name, args, ctx, {
    surface: "mcp",
  });
  return browserNavigate.output.parse(output);
}
