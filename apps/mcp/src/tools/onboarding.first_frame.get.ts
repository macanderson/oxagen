import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...onboardingFirstFrameGet.input.shape,
  agentId: onboardingFirstFrameGet.input.shape.agentId.describe(
    "The registered agent (agt_…) whose first frame to wait for",
  ),
  waitMs: onboardingFirstFrameGet.input.shape.waitMs.describe(
    "Wait up to this long (ms, max 20000) for the first frame before answering",
  ),
};

export const metadata: ToolMetadata = {
  name: onboardingFirstFrameGet.name,
  description: onboardingFirstFrameGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function onboardingFirstFrameGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(onboardingFirstFrameGet.name, args, ctx, {
    surface: "mcp",
  });
  return onboardingFirstFrameGet.output.parse(output);
}
