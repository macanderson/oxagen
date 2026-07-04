import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalDatasetList } from "@oxagen/oxagen/contracts/eval.dataset.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalDatasetList.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalDatasetList.name,
  description: evalDatasetList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function evalDatasetListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalDatasetList.name, args, ctx, {
    surface: "mcp",
  });
  return evalDatasetList.output.parse(output);
}
