import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalRunStatus } from "@oxagen/oxagen/contracts/eval.run.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalRunStatus.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalRunStatus.name,
  description: evalRunStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalRunStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalRunStatus.name, args, ctx, {
    surface: "mcp",
  });
  return evalRunStatus.output.parse(output);
}
