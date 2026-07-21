import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runEvidenceSubmit } from "@oxagen/oxagen/contracts/run.evidence.submit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...runEvidenceSubmit.input.shape,
};

export const metadata: ToolMetadata = {
  name: runEvidenceSubmit.name,
  description: runEvidenceSubmit.description,
  annotations: {
    // Appends one immutable manifest; identical resubmission dedupes (no new
    // write), so it is non-destructive and idempotent.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runEvidenceSubmitTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runEvidenceSubmit.name, args, ctx, {
    surface: "mcp",
  });
  return runEvidenceSubmit.output.parse(output);
}
