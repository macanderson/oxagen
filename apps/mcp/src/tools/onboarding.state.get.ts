import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...onboardingStateGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: onboardingStateGet.name,
  description: onboardingStateGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function onboardingStateGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(onboardingStateGet.name, args, ctx, {
    surface: "mcp",
  });
  return onboardingStateGet.output.parse(output);
}
