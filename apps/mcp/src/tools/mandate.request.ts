import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mandateRequest } from "@oxagen/oxagen/contracts/mandate.request";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { mandateBodyFields } from "@oxagen/oxagen/mandates/schemas";

// The contract input wraps the fields in `.refine()` (validTo after
// validFrom), a ZodEffects with no `.shape`; the field map is the surface's
// argument schema and the kernel re-validates through the contract.
export const schema = mandateBodyFields;

export const metadata: ToolMetadata = {
  name: mandateRequest.name,
  description: mandateRequest.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function mandateRequestTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mandateRequest.name, args, ctx, {
    surface: "mcp",
  });
  return mandateRequest.output.parse(output);
}
