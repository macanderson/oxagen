import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  name: z.string().min(1).describe("Automation name"),
  trigger: z.string().optional().describe("Trigger event type (optional)"),
  action: z.string().optional().describe("Action type to execute when triggered (optional)"),
};

export const metadata: ToolMetadata = {
  name: automationCreate.name,
  description: automationCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function automationCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationCreate.name, args, ctx, { surface: "mcp" });
  return automationCreate.output.parse(output);
}
