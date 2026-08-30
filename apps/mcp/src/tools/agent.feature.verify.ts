import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentFeatureVerify } from "@oxagen/oxagen/contracts/agent.feature.verify";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentFeatureVerify.input.shape,
  requirement: agentFeatureVerify.input.shape.requirement.describe(
    "What the feature is supposed to do or show — the spec the judge holds the screenshots against",
  ),
  screenshotKeys: agentFeatureVerify.input.shape.screenshotKeys.describe(
    "Private asset keys from screenshot_page — the images the judge reads (1–8 keys)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentFeatureVerify.name,
  description: agentFeatureVerify.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentFeatureVerifyTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentFeatureVerify.name, args, ctx, {
    surface: "mcp",
  });
  return agentFeatureVerify.output.parse(output);
}
