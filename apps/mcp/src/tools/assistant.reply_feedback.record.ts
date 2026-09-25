import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { assistantReplyFeedbackRecord } from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...assistantReplyFeedbackRecord.input.shape };

export const metadata: ToolMetadata = {
  name: assistantReplyFeedbackRecord.name,
  description: assistantReplyFeedbackRecord.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    // A second vote is a second row, so a repeat call is not a no-op.
    idempotentHint: false,
  },
};

export default async function recordReplyFeedbackTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(assistantReplyFeedbackRecord.name, args, ctx, {
    surface: "mcp",
  });
  return assistantReplyFeedbackRecord.output.parse(output);
}
