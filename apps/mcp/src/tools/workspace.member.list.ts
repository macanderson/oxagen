import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...listMembers.input.shape,
};

export const metadata: ToolMetadata = {
  name: listMembers.name,
  description: listMembers.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listMembersTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(listMembers.name, args, ctx, { surface: "mcp" });
  return toolResult(listMembers.output.parse(output));
}
