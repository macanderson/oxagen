import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { instructionPromote } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...instructionPromote.input.shape };

// It opens a steering PR and changes no production branch. A second call is
// refused while the finding's proposal is open, and opens a new proposal once
// that one closes.
export const metadata: ToolMetadata = {
  name: instructionPromote.name,
  description: instructionPromote.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function promoteInstructionToSteeringTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(instructionPromote.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(instructionPromote.output.parse(output));
}
