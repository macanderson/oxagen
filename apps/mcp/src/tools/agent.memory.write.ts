import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryWrite } from "@oxagen/oxagen/contracts/agent.memory.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context.js";

export const schema = {
  nodeRef: z.string().describe("Graph node reference to attach the memory to"),
  weight: z
    .enum(["low", "high", "critical"])
    .describe("Memory weight / priority"),
  kind: z
    .enum([
      "routine-change",
      "constraint",
      "bug-root-cause",
      "convention-deviation",
      "gotcha",
    ])
    .describe("Memory category"),
  lesson: z.string().min(1).max(2000).describe("The lesson or insight to persist"),
  source: z
    .enum(["feature", "fix", "exception-watcher", "bug-report"])
    .describe("Origin of the memory"),
};

export const metadata: ToolMetadata = {
  name: agentMemoryWrite.name,
  description: agentMemoryWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryWrite.name, args, ctx, { surface: "mcp" });
  return agentMemoryWrite.output.parse(output);
}
