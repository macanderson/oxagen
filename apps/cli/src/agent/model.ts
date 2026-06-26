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
