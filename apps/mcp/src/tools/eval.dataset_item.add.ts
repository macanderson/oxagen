import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { evalDatasetItemAdd } from "@oxagen/oxagen/contracts/eval.dataset_item.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...evalDatasetItemAdd.input.shape,
};

export const metadata: ToolMetadata = {
  name: evalDatasetItemAdd.name,
  description: evalDatasetItemAdd.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function evalDatasetItemAddTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(evalDatasetItemAdd.name, args, ctx, {
    surface: "mcp",
  });
  return evalDatasetItemAdd.output.parse(output);
}
