import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserRefresh } from "@oxagen/oxagen/contracts/browser.refresh";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserRefresh.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserRefresh.name,
  description: browserRefresh.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function browserRefreshTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserRefresh.name, args, ctx, {
    surface: "mcp",
  });
  return browserRefresh.output.parse(output);
}
