import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalDatasetCreate } from "@oxagen/oxagen/contracts/eval.dataset.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalDatasetCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalDatasetCreate.name,
  description: evalDatasetCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function evalDatasetCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalDatasetCreate.name, args, ctx, {
    surface: "mcp",
  });
  return evalDatasetCreate.output.parse(output);
}
