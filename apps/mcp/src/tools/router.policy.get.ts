import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { routerPolicyGet } from "@oxagen/oxagen/contracts/router.policy.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...routerPolicyGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: routerPolicyGet.name,
  description: routerPolicyGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function routerPolicyGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(routerPolicyGet.name, args, ctx, {
    surface: "mcp",
  });
  return routerPolicyGet.output.parse(output);
}
