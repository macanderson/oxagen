/**
 * Model capability types for dynamic effort/reasoning validation.
 * Queried from Vercel's /v1/models endpoint, cached locally.
 */

export type EffortLevel = "low" | "medium" | "high" | "max";

/**
 * Capabilities of a single model, extracted from Vercel's model card.
 */
export interface ModelCapabilities {
  /** Model ID (e.g., "claude-fable-5"). */
  id: string;
  /** Provider (e.g., "anthropic", "openai"). */
  provider: string;
  /** Human-readable name. */
  name: string;
  /** Effort levels this model supports. */
  supportedEfforts: EffortLevel[];
  /** Context window size in tokens. */
  contextWindow: number;
  /** Max output tokens. */
  maxOutputTokens: number;
  /** Cost per 1M input tokens. */
  costPer1MInputTokens: number;
}

/**
 * The cached model capabilities bundle.
 */
export interface ModelCache {
  /** ISO timestamp when cache was created. */
  cachedAt: number;
  /** TTL in milliseconds (default 24h). */
  ttlMs: number;
  /** Models indexed by ID. */
  models: Record<string, ModelCapabilities>;
}

/**
 * Result of validating effort against a model's capabilities.
 */
export interface EffortValidation {
  /** True if the requested effort is supported. */
  supported: boolean;
  /** The validated/clamped effort level. */
  clampedEffort: EffortLevel;
  /** Reason for clamping (if not supported). */
  reason?: string;
}
