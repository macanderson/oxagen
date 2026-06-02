import { z } from "zod";
import { registerCapability } from "../registry";

// ── Contract ───────────────────────────────────────────────────────────────────

export const videoGenerate = registerCapability({
  name: "video.generate",
  domain: "video",
  description:
    "Generate a short video from a text prompt. Optionally accepts duration, aspect ratio, " +
    "style hints, and a brand-kit ID. Currently a console-logging stub — " +
    "deferred backing (video rendering pipeline not yet wired). " +
    "Returns a queued job reference and a render directive so the chat UI " +
    'immediately shows the make-a-video form component (componentId "make-video-form").',
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "video",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Natural-language description of the video to generate. */
    prompt: z.string().min(1),
    /** Duration of the output video in whole seconds (1–60). */
    durationSeconds: z.number().int().min(1).max(60).optional(),
    /** Target aspect ratio for the output. */
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
    /** Free-text style hint passed to the rendering model (e.g. "cinematic", "animated"). */
    style: z.string().optional(),
    /** Optional brand-kit ID to apply to the generated video. */
    brandKitId: z.string().optional(),
  }),
  output: z.object({
    stub: z.literal(true),
    /** Current lifecycle status — always "queued" for the stub. */
    status: z.literal("queued"),
    /** Opaque job identifier for future polling once the pipeline is live. */
    jobId: z.string().min(1),
    /**
     * Render directive consumed by the chat stream route.
     * The componentId must match the CHAT_COMPONENTS registry key exactly.
     */
    render: z.object({
      componentId: z.literal("make-video-form"),
      props: z.object({
        prompt: z.string().optional(),
        durationSeconds: z.number().optional(),
        aspectRatio: z.string().optional(),
        style: z.string().optional(),
      }),
    }),
  }),
});

export type VideoGenerateInput = z.output<typeof videoGenerate.input>;
export type VideoGenerateOutput = z.output<typeof videoGenerate.output>;
