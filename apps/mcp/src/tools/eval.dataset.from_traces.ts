import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalDatasetFromTraces } from "@oxagen/oxagen/contracts/eval.dataset.from_traces";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalDatasetFromTraces.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalDatasetFromTraces.name,
  description: evalDatasetFromTraces.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function evalDatasetFromTracesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalDatasetFromTraces.name, args, ctx, {
    surface: "mcp",
  });
  return evalDatasetFromTraces.output.parse(output);
}
