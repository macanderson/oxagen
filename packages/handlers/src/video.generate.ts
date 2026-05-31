import { randomUUID } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// STUB — video rendering pipeline is deferred. The handler logs intent and
// returns a fully-typed queued result with a render directive so the chat UI
// immediately surfaces the make-a-video form component.
//
// Policy §0.5: stubs MUST be fully typed, NEVER throw, return a valid typed
// result, and console.log intent.

export const videoGenerateHandler: CapabilityHandler<typeof videoGenerate> = async (
  input,
  _ctx,
) => {
  const jobId = `stub_${randomUUID()}`;

  console.log(
    `[stub] video.generate would generate a video for: "${input.prompt}"` +
      (input.durationSeconds !== undefined ? ` (${input.durationSeconds}s)` : "") +
      (input.aspectRatio !== undefined ? ` [${input.aspectRatio}]` : "") +
      (input.style !== undefined ? ` style="${input.style}"` : "") +
      (input.brandKitId !== undefined ? ` brandKit=${input.brandKitId}` : "") +
      ` — jobId=${jobId}`,
  );

  return {
    stub: true,
    status: "queued",
    jobId,
    render: {
      componentId: "make-video-form",
      props: {
        prompt: input.prompt,
        ...(input.durationSeconds !== undefined && { durationSeconds: input.durationSeconds }),
        ...(input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
        ...(input.style !== undefined && { style: input.style }),
      },
    },
  };
};
