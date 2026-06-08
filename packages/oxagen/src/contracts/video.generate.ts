import { z } from "zod";
import { registerCapability } from "../registry";

// ── Contract ───────────────────────────────────────────────────────────────────

export const videoGenerate = registerCapability({
  name: "video.generate",
  domain: "video",
  description:
    "Generate a short video from a text prompt. Optionally accepts duration, aspect ratio, " +
    "and style hints. Creates a pending asset row, dispatches the async Veo render job, " +
    "and returns a queued job reference and a render directive so the chat UI " +
    'immediately shows the video-result component (componentId "video-result").',
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
    /** Current lifecycle status — always "queued" for an async render. */
    status: z.literal("queued"),
    /** Opaque job identifier (the generated_assets public id) for future polling. */
    jobId: z.string().min(1),
    /**
     * Access-controlled serving URL. Returns 404 while the render is pending
     * and streams the video once the asset row is flipped to `ready`.
     */
    serveUrl: z.string(),
    /**
     * Render directive consumed by the chat stream route.
     * The componentId must match the CHAT_COMPONENTS registry key exactly.
     */
    render: z.object({
      componentId: z.literal("video-result"),
      props: z.object({
        url: z.string(),
        prompt: z.string(),
      }),
    }),
  }),
});

export type VideoGenerateInput = z.output<typeof videoGenerate.input>;
export type VideoGenerateOutput = z.output<typeof videoGenerate.output>;
