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
import { DEFAULT_CODING_MODEL } from "./model-catalog.js";

/**
 * Default coding model. Override per-call (`opts.model`), per-shell
 * (`OXAGEN_MODEL`), or persistently (`oxagen config model <slug>`).
 * If the gateway reports the slug as unknown, set a current one with
 * `oxagen config model <slug>` — gateway slugs drift over time.
 *
 * Resolves to the latest-GA balanced/Sonnet slug from the model catalog, the
 * single place that tracks "latest" per family.
 */
export const DEFAULT_MODEL = DEFAULT_CODING_MODEL;

export function resolveModelId(override?: string): string {
  return (
    override ??
    process.env["OXAGEN_MODEL"] ??
    readConfig().model ??
    DEFAULT_MODEL
  );
}

/**
 * Reasoning effort levels forwarded to models that support a thinking mode.
 * `xhigh`/`max` are the deepest Anthropic (Claude Opus) tiers; vendors without
 * them clamp to `high` server-side.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
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
