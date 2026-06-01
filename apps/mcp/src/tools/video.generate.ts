import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context.js";

// Stub video generation tool. Dispatches through kernel.invoke() so IAM
// enforcement, ClickHouse audit, and tool_invocations metering apply uniformly.
// The handler is a typed no-throw stub that logs intent and returns a queued
// job reference — no actual video rendering runs until the pipeline is wired.

export const schema = {
  prompt: z.string().min(1).describe("Natural-language description of the video to generate"),
  durationSeconds: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe("Duration of the output video in whole seconds (1–60)"),
  aspectRatio: z
    .enum(["16:9", "9:16", "1:1"])
    .optional()
    .describe("Target aspect ratio for the output"),
  style: z
    .string()
    .optional()
    .describe("Free-text style hint for the rendering model (e.g. \"cinematic\", \"animated\")"),
  brandKitId: z
    .string()
    .optional()
    .describe("Optional brand-kit ID to apply to the generated video"),
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

export default async function videoGenerateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(videoGenerate.name, args, ctx, { surface: "mcp" });
  return videoGenerate.output.parse(output);
}
