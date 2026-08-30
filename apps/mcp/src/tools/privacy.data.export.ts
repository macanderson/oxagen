import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...privacyDataExport.input.shape,
  scope: privacyDataExport.input.shape.scope.describe(
    '"user" to export the current user\'s personal data, "org" to export all organization data (Owner/Admin only).',
  ),
};

export const metadata: ToolMetadata = {
  name: privacyDataExport.name,
  description: privacyDataExport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function privacyDataExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(privacyDataExport.name, args, ctx, {
    surface: "mcp",
  });
  return privacyDataExport.output.parse(output);
}
