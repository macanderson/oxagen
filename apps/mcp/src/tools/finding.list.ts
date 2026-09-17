import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  status: findingList.input.shape.status.describe(
    "open (default), applied or dismissed",
  ),
};

export const metadata: ToolMetadata = {
  name: findingList.name,
  description: findingList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function findingListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = findingList.input.parse(args);
  const output = await invoke(findingList.name, input, ctx, {
    surface: "mcp",
  });
  return findingList.output.parse(output);
}
