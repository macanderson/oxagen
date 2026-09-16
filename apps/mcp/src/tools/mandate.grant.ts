import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateGrant } from "@oxagen/oxagen/contracts/mandate.grant";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { mandateGrantFields } from "@oxagen/oxagen/mandates/schemas";

// The contract input wraps the fields in `.refine()` (validTo after
// validFrom), a ZodEffects with no `.shape`; the field map is the surface's
// argument schema and the kernel re-validates through the contract.
export const schema = mandateGrantFields;

export const metadata: ToolMetadata = {
  name: mandateGrant.name,
  description: mandateGrant.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function mandateGrantTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateGrant.name, args, ctx, { surface: "mcp" });
  return mandateGrant.output.parse(output);
}
