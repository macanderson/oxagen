import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { mandateLimitsUpdateFields } from "@oxagen/oxagen/contracts/mandate.limits.update";

// The contract input carries a `.refine()` (at least one change named), a
// ZodEffects with no `.shape`; the field map is the surface's argument schema
// and the kernel re-validates through the contract.
export const schema = mandateLimitsUpdateFields;

export const metadata: ToolMetadata = {
  name: mandateLimitsUpdate.name,
  description: mandateLimitsUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function mandateLimitsUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateLimitsUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return mandateLimitsUpdate.output.parse(output);
}
