import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Video generation tool. Dispatches through kernel.invoke() so IAM enforcement,
// ClickHouse audit, and tool_invocations metering apply uniformly. The handler
// creates a `pending` generated_assets row and enqueues `agent/video.render` on
// Inngest — the async worker renders the video, uploads to blob, and flips the
// row to `ready`. Returns a queued job reference (status, jobId, serving URL,
// render directive) immediately without awaiting the render.

export const schema = {
  ...videoGenerate.input.shape,
  prompt: videoGenerate.input.shape.prompt.describe(
    "Natural-language description of the video to generate",
  ),
  durationSeconds: videoGenerate.input.shape.durationSeconds.describe(
    "Duration of the output video in whole seconds (1–60)",
  ),
  aspectRatio: videoGenerate.input.shape.aspectRatio.describe(
    "Target aspect ratio for the output",
  ),
  style: videoGenerate.input.shape.style.describe(
    'Free-text style hint for the rendering model (e.g. "cinematic", "animated")',
  ),
};

export const metadata: ToolMetadata = {
  name: videoGenerate.name,
  description: videoGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function videoGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(videoGenerate.name, args, ctx, {
    surface: "mcp",
  });
  return videoGenerate.output.parse(output);
}
