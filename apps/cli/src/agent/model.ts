/**
 * Model resolution for the local agent loop.
 *
 * Models are passed to the AI SDK as plain Vercel AI Gateway slugs
 * (`vendor/model`), which the gateway resolves using `AI_GATEWAY_API_KEY`.
 *
 * Resolution order: `--model` / opts → `OXAGEN_MODEL` env → `model` in config →
 * the default below.
 */
import { readConfig } from "../lib/config.js";

/**
 * Default coding model. Override per-call (`opts.model`), per-shell
 * (`OXAGEN_MODEL`), or persistently (`oxagen config model <slug>`).
 * If the gateway reports the slug as unknown, set a current one with
 * `oxagen config model <slug>` — gateway slugs drift over time.
 */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function resolveModelId(override?: string): string {
  return (
    override ??
    process.env["OXAGEN_MODEL"] ??
    readConfig().model ??
    DEFAULT_MODEL
  );
}

/** Reasoning effort levels forwarded to models that support a thinking mode. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof EFFORT_LEVELS)[number];

/** Type guard: is `s` a valid reasoning-effort level? */
export function isReasoningEffort(s: string): s is ReasoningEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(s);
}

/**
 * Resolve the reasoning effort for a turn. Order: explicit override →
 * `OXAGEN_EFFORT` env → `effort` in config → undefined (let the model/server
 * default decide). Undefined is meaningful: it forwards no `reasoning_effort`,
 * so a model's own default governs.
 */
export function resolveEffort(override?: string): ReasoningEffort | undefined {
  const raw = override ?? process.env["OXAGEN_EFFORT"] ?? readConfig().effort;
  if (raw && isReasoningEffort(raw)) return raw;
  return undefined;
}
