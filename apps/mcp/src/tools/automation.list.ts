import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  workspace_id: z
    .string()
    .optional()
    .describe("Workspace ID (defaults to current workspace)"),
};

export const metadata: ToolMetadata = {
  name: automationList.name,
  description: automationList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function automationListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationList.name, args, ctx, { surface: "mcp" });
  return automationList.output.parse(output);
}
