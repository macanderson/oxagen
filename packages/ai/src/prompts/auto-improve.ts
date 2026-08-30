import pino from "pino";
import { z } from "zod";
import type { Surface } from "@oxagen/telemetry";
import { generateObjectFor } from "../generate-object";
import { selectModel } from "../models";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.auto-improve" },
});

/**
 * "Auto-improve prompts" (Beta) — an LLM judge that decides whether a user's
 * content/media-generation prompt is sufficient as-is and, if not, rewrites it
 * with faithful additional context. Gated by the workspace `autoImprovePrompts`
 * setting (default ON). Runs on the fast tier and is fully best-effort: any
 * failure returns the original prompt unchanged so generation never blocks.
 *
 * The judge is intentionally conservative — it must NOT invent requirements the
 * user did not imply (the documented "may yield unintended results" caveat).
 */

const judgeSchema = z.object({
  sufficient: z
    .boolean()
    .describe(
      "True if the prompt is already clear and complete enough for a high-quality result.",
    ),
  enhancedPrompt: z
    .string()
    .optional()
    .describe(
      "When sufficient=false, a rewritten prompt that adds helpful, faithful detail and context. Must preserve the user's intent and invent nothing they did not imply. Omit when sufficient=true.",
    ),
});

function judgeSystemPrompt(kind: string): string {
  return [
    `You are a prompt-quality judge for ${kind} generation.`,
    "Decide whether the user's prompt is sufficient to produce a high-quality result.",
    "- If it is clear, specific, and complete, set sufficient=true and omit enhancedPrompt.",
    "- If it is vague, underspecified, or missing context, set sufficient=false and provide an",
    "  enhancedPrompt that adds helpful, faithful detail while strictly preserving the user's",
    "  intent. Do NOT invent requirements, brands, names, or constraints the user did not imply.",
    "Be conservative: when in doubt, prefer sufficient=true over an aggressive rewrite.",
  ].join("\n");
}

export interface EnhancePromptArgs {
  /** The user's raw generation prompt. */
  prompt: string;
  /** Content kind, for the judge's framing: "image" | "svg" | "document" | … */
  kind: string;
  /** Resolved toggle — pass `config.autoImprovePrompts ?? true` (default ON). */
  autoImprove: boolean;
  // messageId is the UUID of the initiating message, or null when there is none
  // — it flows verbatim into token_usage.execution_step_id (UUID) via
  // generateObjectFor, so it must be a valid UUID or null, never a free-form
  // string like "unknown".
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    messageId: string | null;
  };
}

export interface EnhancePromptResult {
  /** The prompt to actually use (original, or the judge's enhancement). */
  prompt: string;
  /** True when the judge rewrote the prompt. */
  enhanced: boolean;
}

export async function enhancePromptIfInsufficient(
  args: EnhancePromptArgs,
): Promise<EnhancePromptResult> {
  if (!args.autoImprove || args.prompt.trim().length === 0) {
    return { prompt: args.prompt, enhanced: false };
  }
  try {
    const { object } = await generateObjectFor({
      schema: judgeSchema,
      model: selectModel({ tier: "fast" }),
      system: judgeSystemPrompt(args.kind),
      prompt: args.prompt,
      temperature: 0.2,
      telemetry: args.telemetry,
    });
    const enhanced = object.enhancedPrompt?.trim();
    if (object.sufficient || !enhanced) {
      return { prompt: args.prompt, enhanced: false };
    }
    return { prompt: enhanced, enhanced: true };
  } catch (err) {
    // Best-effort — a judge failure must never block the generation it precedes.
    // Logged rather than swallowed silently: a judge that fails on every call
    // still bills a model turn per generation while doing nothing, and a bare
    // catch makes that invisible. Same reasoning as loadWorkspacePromptConfigSafe.
    logger.warn(
      { err, kind: args.kind, surface: args.telemetry.surface },
      "auto-improve judge failed — using the original prompt",
    );
    return { prompt: args.prompt, enhanced: false };
  }
}
