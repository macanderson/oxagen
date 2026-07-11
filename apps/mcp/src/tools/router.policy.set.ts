import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { routerPolicySet } from "@oxagen/oxagen/contracts/router.policy.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...routerPolicySet.input.shape,
};

export const metadata: ToolMetadata = {
  name: routerPolicySet.name,
  description: routerPolicySet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function routerPolicySetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(routerPolicySet.name, args, ctx, {
    surface: "mcp",
  });
  return routerPolicySet.output.parse(output);
}
