import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runIssuesGet } from "@oxagen/oxagen/contracts/run.issues.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  runId: runIssuesGet.input.shape.runId.describe(
    "The run's public id: arun_… (evidence ledger) or tse_… (wrapped agent session)",
  ),
};

export const metadata: ToolMetadata = {
  name: runIssuesGet.name,
  description: runIssuesGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runIssuesGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runIssuesGet.name, args, ctx, {
    surface: "mcp",
  });
  return runIssuesGet.output.parse(output);
}
