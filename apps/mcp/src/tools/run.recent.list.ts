import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runRecentList } from "@oxagen/oxagen/contracts/run.recent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...runRecentList.input.shape };

export const metadata: ToolMetadata = {
  name: runRecentList.name,
  description: runRecentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listRecentRunsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(runRecentList.name, args, ctx, {
    surface: "mcp",
  });
  return runRecentList.output.parse(output);
}
