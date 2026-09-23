import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoDelete } from "@oxagen/oxagen/contracts/org.sso.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  providerId: orgSsoDelete.input.shape.providerId.describe(
    "The id of the provider to delete",
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoDelete.name,
  description: orgSsoDelete.description,
  annotations: {
    readOnlyHint: false,
    // The provider and its group-role mappings are gone for good, and SSO
    // stops being required when no verified provider remains.
    destructiveHint: true,
    // A second delete of the same provider is not_found.
    idempotentHint: false,
  },
};

export default async function orgSsoDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoDelete.name, args, ctx, { surface: "mcp" });
  return orgSsoDelete.output.parse(output);
}
