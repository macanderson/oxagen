import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = privacyDataExportStatus.input.shape;

export const metadata: ToolMetadata = {
  name: privacyDataExportStatus.name,
  description: privacyDataExportStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function privacyDataExportStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(privacyDataExportStatus.name, args, ctx, {
    surface: "mcp",
  });
  return privacyDataExportStatus.output.parse(output);
}
