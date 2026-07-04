import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalDatasetGet } from "@oxagen/oxagen/contracts/eval.dataset.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalDatasetGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalDatasetGet.name,
  description: evalDatasetGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalDatasetGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalDatasetGet.name, args, ctx, {
    surface: "mcp",
  });
  return evalDatasetGet.output.parse(output);
}
