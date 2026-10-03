import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workTriageRevise } from "@oxagen/oxagen/contracts/work.triage.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...workTriageRevise.input.shape };

export const metadata: ToolMetadata = {
  name: workTriageRevise.name,
  description: workTriageRevise.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function reviseWorkTriageTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workTriageRevise.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(workTriageRevise.output.parse(output));
}
