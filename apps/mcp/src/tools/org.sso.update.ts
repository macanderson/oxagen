import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoUpdate } from "@oxagen/oxagen/contracts/org.sso.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

const shape = orgSsoUpdate.input.shape;

export const schema = {
  ...shape,
  providerId: shape.providerId.describe("The id of the provider to change"),
  displayName: shape.displayName.describe(
    "A new name for the sign-in button. Omit to keep the current one",
  ),
  groupsClaim: shape.groupsClaim.describe(
    "A new groups claim or attribute. Omit to keep the current one",
  ),
  config: shape.config.describe(
    "New protocol settings, in the same shape as create_sso_provider. The protocol must match. Omit clientSecret or spPrivateKey to keep the stored one",
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoUpdate.name,
  description: orgSsoUpdate.description,
  annotations: {
    readOnlyHint: false,
    // Replaces settings in place; the previous values are not kept.
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSsoUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoUpdate.name, args, ctx, { surface: "mcp" });
  return orgSsoUpdate.output.parse(output);
}
