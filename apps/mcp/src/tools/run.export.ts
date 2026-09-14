import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runExport.input.shape.runId.describe(
    "The sealed run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
};

export const metadata: ToolMetadata = {
  name: runExport.name,
  description: runExport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function runExportTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runExport.name, args, ctx, { surface: "mcp" });
  return runExport.output.parse(output);
}
