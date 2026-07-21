import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runEvidenceList } from "@oxagen/oxagen/contracts/run.evidence.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...runEvidenceList.input.shape,
  limit: runEvidenceList.input.shape.limit.describe(
    "Max manifests to return (1–100)",
  ),
};

export const metadata: ToolMetadata = {
  name: runEvidenceList.name,
  description: runEvidenceList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runEvidenceListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runEvidenceList.name, args, ctx, {
    surface: "mcp",
  });
  return runEvidenceList.output.parse(output);
}
