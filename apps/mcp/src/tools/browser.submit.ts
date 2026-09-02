import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserSubmit } from "@oxagen/oxagen/contracts/browser.submit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserSubmit.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserSubmit.name,
  description: browserSubmit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function browserSubmitTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserSubmit.name, args, ctx, {
    surface: "mcp",
  });
  return browserSubmit.output.parse(output);
}
