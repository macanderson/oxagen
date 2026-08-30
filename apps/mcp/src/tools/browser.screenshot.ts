import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { browserScreenshot } from "@oxagen/oxagen/contracts/browser.screenshot";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...browserScreenshot.input.shape,
};

export const metadata: ToolMetadata = {
  name: browserScreenshot.name,
  description: browserScreenshot.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function browserScreenshotTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(browserScreenshot.name, args, ctx, {
    surface: "mcp",
  });
  return browserScreenshot.output.parse(output);
}
