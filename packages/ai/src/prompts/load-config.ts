// Server-only helper — imports @oxagen/database. Do not import in client code.
//
// Reads a workspace's prompt configuration from the
// `workspace.workspaces.prompt_config` column and normalizes it into the
// PromptConfig shape resolvePrompt() consumes. Best-effort: any shape mismatch
// or missing row resolves to an empty config (untouched baselines).

import pino from "pino";
import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  type PromptConfig,
  type OverridablePromptKey,
  OVERRIDABLE_PROMPT_KEYS,
} from "./registry";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.prompts" },
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Normalize an untrusted JSONB blob into a typed, safe PromptConfig. */
export function normalizePromptConfig(raw: unknown): PromptConfig {
  if (!isRecord(raw)) return {};

  const additionalInstructions =
    typeof raw.additionalInstructions === "string"
      ? raw.additionalInstructions
      : null;

  const autoImprovePrompts =
    typeof raw.autoImprovePrompts === "boolean" ? raw.autoImprovePrompts : null;

  let overrides: Partial<Record<OverridablePromptKey, string>> | null = null;
  if (isRecord(raw.overrides)) {
    const acc: Partial<Record<OverridablePromptKey, string>> = {};
    for (const key of OVERRIDABLE_PROMPT_KEYS) {
      const val = (raw.overrides as Record<string, unknown>)[key];
      if (typeof val === "string" && val.trim().length > 0) acc[key] = val;
    }
    if (Object.keys(acc).length > 0) overrides = acc;
  }

  return { additionalInstructions, autoImprovePrompts, overrides };
}

/**
 * Load the effective PromptConfig for a workspace. Returns an empty config (no
 * overrides, no appended instructions) when there is no workspace context, no
 * row, or no `promptConfig` key — i.e. baselines pass through unchanged.
 */
export async function loadWorkspacePromptConfig(
  workspaceId: string | null,
): Promise<PromptConfig> {
  if (!workspaceId) return {};
  const row = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
      columns: { promptConfig: true },
    }),
  );
  return normalizePromptConfig(row?.promptConfig);
}

/**
 * Best-effort wrapper around {@link loadWorkspacePromptConfig}. A prompt-settings
 * read failure (RLS/DB error, connection loss) must not silently revert a
 * workspace's configured prompt behavior to defaults with no trace — it logs the
 * failure once and then degrades to an empty config (baselines pass through).
 * Use this instead of a bare `.catch(() => ({}))` so the degrade is observable.
 */
export async function loadWorkspacePromptConfigSafe(
  workspaceId: string | null,
): Promise<PromptConfig> {
  try {
    return await loadWorkspacePromptConfig(workspaceId);
  } catch (err) {
    logger.warn(
      { err, workspaceId },
      "prompt-config read failed — using defaults",
    );
    return {};
  }
}
