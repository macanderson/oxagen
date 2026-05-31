"use server";

// ── Server action: video.generate ─────────────────────────────────────────────
//
// STUB — video rendering pipeline is deferred. This action validates the
// form submission and delegates to the videoGenerateHandler, returning a typed
// queued result. It NEVER throws; on any error it returns ok: false with a
// human-readable message.
//
// The action is intentionally inert beyond logging: no DB write, no job queue,
// no billing charge. A Linear follow-up ticket tracks the real wiring.

import { videoGenerateHandler } from "@oxagen/handlers/video.generate";
import { videoGenerate, type VideoGenerateInput } from "@oxagen/oxagen/contracts/video.generate";
import { randomUUID } from "node:crypto";

export interface VideoGenerateFormData {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  style?: string;
}

export type VideoGenerateActionResult =
  | { ok: true; queued: true; jobId: string }
  | { ok: false; error: string };

export async function videoGenerateAction(
  data: VideoGenerateFormData,
): Promise<VideoGenerateActionResult> {
  // Validate with the capability's own Zod schema so the action never drifts
  // from the contract definition.
  const parsed = videoGenerate.input.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid video generation request",
    };
  }

  // Stub capability context — no real org/workspace scope when invoked from
  // the chat component (the form is pre-populated by the agent turn that
  // already ran in the org scope). The action is inert so this is safe.
  const stubCtx = {
    orgId: "stub",
    workspaceId: "stub",
    userId: "stub",
    apiKeyId: null as string | null,
    requestId: randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const input: VideoGenerateInput = parsed.data;

  try {
    const result = await videoGenerateHandler(input, stubCtx);
    console.log(
      `[stub] videoGenerateAction — queued jobId=${result.jobId} for prompt="${input.prompt}"`,
    );
    return { ok: true, queued: true, jobId: result.jobId };
  } catch {
    // Handler never throws by policy, but guard regardless.
    return { ok: false, error: "Video generation could not be queued. Please try again." };
  }
}
