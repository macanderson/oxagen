import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workTriageRetry } from "@oxagen/oxagen/contracts/work.triage.retry";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workTriageRetry.input.shape };

export const metadata: ToolMetadata = {
  name: workTriageRetry.name,
  description: workTriageRetry.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function retryWorkTriageTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workTriageRetry.name, args, ctx, {
    surface: "mcp",
  });
  return workTriageRetry.output.parse(output);
}
