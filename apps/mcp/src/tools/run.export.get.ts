import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runExportGet } from "@oxagen/oxagen/contracts/run.export.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  exportId: runExportGet.input.shape.exportId.describe(
    "The export id export_run answered: rexp_…",
  ),
};

export const metadata: ToolMetadata = {
  name: runExportGet.name,
  description: runExportGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runExportGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runExportGet.name, args, ctx, { surface: "mcp" });
  return runExportGet.output.parse(output);
}
