/**
 * Model cache management: load from disk, fetch from Vercel, validate effort.
 *
 * Cache location: ~/.oxagen/model-cache.json
 * TTL: 24 hours
 * Fallback: conservative defaults if cache missing/expired
 */

import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { EffortLevel, EffortValidation, ModelCache, ModelCapabilities } from "./types";

export type { EffortLevel, EffortValidation, ModelCache, ModelCapabilities };

const CACHE_DIR = join(homedir(), ".oxagen");
const CACHE_FILE = join(CACHE_DIR, "model-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default effort support for common models. Used as fallback if cache unavailable.
 * Conservative: assume each model supports fewer efforts until proven otherwise.
 */
const FALLBACK_CAPABILITIES: Record<string, EffortLevel[]> = {
  "claude-fable-5": ["low", "medium", "high", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "max"],
  "claude-sonnet-5": ["low", "medium", "high"],
  "claude-haiku-4-5-20251001": ["low", "medium"],
  // For any unknown model, assume minimal support
};

/**
 * Load the cached model capabilities, checking TTL.
 * Returns null if cache is missing, expired, or invalid.
 */
export async function loadCachedModels(): Promise<ModelCache | null> {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    const cache = JSON.parse(data) as ModelCache;

    // Validate structure
    if (!cache.cachedAt || !cache.models || typeof cache.ttlMs !== "number") {
      return null;
    }

    // Check TTL
    const ageMs = Date.now() - cache.cachedAt;
    if (ageMs > cache.ttlMs) {
      return null; // Expired
    }

    return cache;
  } catch {
    return null; // Missing or unparseable
  }
}

/**
 * Save a cache to disk at ~/.oxagen/model-cache.json.
 * Creates the directory if needed.
 */
export async function saveCachedModels(cache: ModelCache): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal: cache write failure doesn't break the CLI
    console.error("[model-cache] Failed to save cache:", err);
  }
}

/**
 * Fetch model capabilities from Vercel's /v1/models endpoint.
 * The endpoint is at https://api.anthropic.com/v1/models (when using Anthropic API)
 * or the Vercel AI gateway at https://api.gateway.ai.anthropic.com/v1/models.
 *
 * Extracts effort levels from model metadata + known-good defaults.
 */
export async function fetchModelsFromVercel(apiKey?: string): Promise<ModelCapabilities[]> {
  // Use AI Gateway (Vercel) if no explicit key, else Anthropic direct
  const endpoint = "https://api.anthropic.com/v1/models";
  const headers: Record<string, string> = {
    "User-Agent": "oxagen-cli/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (process.env["ANTHROPIC_API_KEY"]) {
    headers["Authorization"] = `Bearer ${process.env["ANTHROPIC_API_KEY"]}`;
  } else if (process.env["AI_GATEWAY_API_KEY"]) {
    headers["Authorization"] = `Bearer ${process.env["AI_GATEWAY_API_KEY"]}`;
  }

  try {
    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const jsonData = await response.json();
    const data = jsonData as {
      data?: Array<{
        id: string;
        created?: number;
        display_name?: string;
        context_window?: number;
        max_output_tokens?: number;
      }>;
    };

    const models: ModelCapabilities[] = [];
    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        const efforts = FALLBACK_CAPABILITIES[model.id] ?? ["low", "medium"];
        models.push({
          id: model.id,
          provider: model.id.includes("claude") ? "anthropic" : "unknown",
          name: model.display_name ?? model.id,
          supportedEfforts: efforts,
          contextWindow: model.context_window ?? 8192,
          maxOutputTokens: model.max_output_tokens ?? 4096,
          costPer1MInputTokens: 0, // Not in response; would need pricing table
        });
      }
    }

    return models;
  } catch (err) {
    console.error("[model-cache] Failed to fetch models from Vercel:", err);
    return [];
  }
}

/**
 * Refresh the model cache: fetch from Vercel, save to disk.
 */
export async function refreshModelCache(apiKey?: string): Promise<ModelCache> {
  const models = await fetchModelsFromVercel(apiKey);
  const cache: ModelCache = {
    cachedAt: Date.now(),
    ttlMs: CACHE_TTL_MS,
    models: models.reduce((acc, m) => ({ ...acc, [m.id]: m }), {}),
  };
  await saveCachedModels(cache);
  return cache;
}

/**
 * Load the cached models, or fetch + cache if missing/expired.
 * Never throws: falls back to empty cache (no capabilities known).
 */
export async function getModelCache(apiKey?: string): Promise<ModelCache> {
  const cached = await loadCachedModels();
  if (cached) {
    return cached;
  }
  const refreshed = await refreshModelCache(apiKey);
  return refreshed.models && Object.keys(refreshed.models).length > 0
    ? refreshed
    : { cachedAt: Date.now(), ttlMs: CACHE_TTL_MS, models: {} };
}

/**
 * Validate an effort level against a model's supported efforts.
 * If unsupported, clamps to the highest supported.
 */
export function validateEffort(
  modelId: string,
  requestedEffort: EffortLevel | undefined,
  cache: ModelCache,
): EffortValidation {
  // Default effort: "medium" (safe for all models)
  const effort = requestedEffort ?? "medium";

  const capabilities = cache.models[modelId];
  if (!capabilities) {
    // Model not in cache: use fallback
    const fallbackEfforts = FALLBACK_CAPABILITIES[modelId] ?? ["low", "medium"];
    const supported = fallbackEfforts.includes(effort);
    if (supported) {
      return { supported: true, clampedEffort: effort };
    }
    // Clamp to highest fallback
    const clamped = fallbackEfforts[fallbackEfforts.length - 1] as EffortLevel;
    return {
      supported: false,
      clampedEffort: clamped,
      reason: `Model ${modelId} not in cache; clamped ${effort} → ${clamped}`,
    };
  }

  if (capabilities.supportedEfforts.includes(effort)) {
    return { supported: true, clampedEffort: effort };
  }

  // Clamp to highest supported (ensure at least one effort exists)
  const clamped =
    capabilities.supportedEfforts[capabilities.supportedEfforts.length - 1] ?? "medium";
  return {
    supported: false,
    clampedEffort: clamped as EffortLevel,
    reason: `Model ${modelId} does not support effort="${effort}"; clamped to "${clamped}"`,
  };
}

/**
 * Get supported efforts for a model, using cache as source of truth.
 */
export function getSupportedEfforts(modelId: string, cache: ModelCache): EffortLevel[] {
  const capabilities = cache.models[modelId];
  return capabilities?.supportedEfforts ?? FALLBACK_CAPABILITIES[modelId] ?? ["low", "medium"];
}
