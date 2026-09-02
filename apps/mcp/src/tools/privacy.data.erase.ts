import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { privacyDataErase } from "@oxagen/oxagen/contracts/privacy.data.erase";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...privacyDataErase.input.shape,
  scope: privacyDataErase.input.shape.scope.describe(
    '"user" to erase the current user\'s account and personal data (any authenticated user), "org" to erase the entire organization (Owner only).',
  ),
  confirm: privacyDataErase.input.shape.confirm.describe(
    "Must be true. Explicit confirmation that you understand this action is irreversible.",
  ),
};

export const metadata: ToolMetadata = {
  name: privacyDataErase.name,
  description: privacyDataErase.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function privacyDataEraseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(privacyDataErase.name, args, ctx, {
    surface: "mcp",
  });
  return privacyDataErase.output.parse(output);
}
