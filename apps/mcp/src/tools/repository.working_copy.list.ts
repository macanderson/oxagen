import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workingCopyList } from "@oxagen/oxagen/contracts/repository.working_copy.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  limit: workingCopyList.input.shape.limit.describe(
    "The most working copies to return, 1 to 200; defaults to 100",
  ),
};

export const metadata: ToolMetadata = {
  name: workingCopyList.name,
  description: workingCopyList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workingCopyListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workingCopyList.name, args, ctx, {
    surface: "mcp",
  });
  return workingCopyList.output.parse(output);
}
