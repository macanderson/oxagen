/**
 * Prompt registry — the single home for every baseline system prompt the
 * platform ships, plus the tiered customer-override resolution that lets
 * workspaces influence (and, for safe prompts, replace) them.
 *
 * Tiered control:
 *  - `additionalInstructions` — appended to EVERY prompt, all tiers. The
 *    universal "tell the assistant about our workspace" knob.
 *  - `overrides[key]` — full replacement, ENTERPRISE-gated, allowed ONLY for the
 *    curated safe keys in OVERRIDABLE_PROMPT_KEYS (content prompts). The core
 *    prompt (`chat.system`) is append-only: it is the governance agent's
 *    contract — what it is, what it must ground every claim in, and that its
 *    gates are not negotiable — so replacement is refused and only the
 *    appended instructions take effect.
 *
 * ADR-041: the BASELINE for `chat.system` does not live here. `@oxagen/agent`
 * owns it (`buildChatSystemPrompt`), because the prompt and the tool surface it
 * describes are one artifact and must change together. This module resolves the
 * customer layer over whatever baseline the caller passes; there is exactly one
 * chat prompt in the repository.
 */

/**
 * Every prompt the platform owns. `chat.system`'s baseline is built by
 * `@oxagen/agent` (see the module docstring); the rest are built below.
 */
export type PromptKey = "chat.system" | "conversation.title";

/**
 * Curated SAFE set — content prompts a customer may fully replace without
 * breaking structural contracts. Everything else is append-only.
 */
export const OVERRIDABLE_PROMPT_KEYS = ["conversation.title"] as const;
export type OverridablePromptKey = (typeof OVERRIDABLE_PROMPT_KEYS)[number];

export function isOverridablePromptKey(
  key: PromptKey,
): key is OverridablePromptKey {
  return (OVERRIDABLE_PROMPT_KEYS as readonly string[]).includes(key);
}

/**
 * Per-workspace prompt configuration, loaded from
 * the `workspace.workspaces.prompt_config` column. All fields optional — an empty
 * config resolves to the untouched baseline (today's behavior).
 */
export interface PromptConfig {
  /** Appended to every prompt's system text (all tiers). */
  additionalInstructions?: string | null;
  /** Full-replacement overrides; honored only for OVERRIDABLE_PROMPT_KEYS. */
  overrides?: Partial<Record<OverridablePromptKey, string>> | null;
  /**
   * When true, an LLM judge may enhance an insufficient user prompt before the
   * turn runs (Beta). Read by `enhancePromptIfInsufficient`, not by
   * `resolvePrompt` itself.
   */
  autoImprovePrompts?: boolean | null;
}

const APPENDED_HEADER = "\n\n---\n\n## Workspace instructions\n\n";

/**
 * Resolve the final system prompt for `key`: start from the rendered baseline,
 * apply a full override when the key is overridable and one is configured, then
 * append the workspace's additional instructions (always, all keys).
 */
export function resolvePrompt(args: {
  key: PromptKey;
  baseline: string;
  config?: PromptConfig | null;
}): string {
  const { key, baseline, config } = args;
  let system = baseline;

  if (config?.overrides && isOverridablePromptKey(key)) {
    const override = config.overrides[key];
    if (typeof override === "string" && override.trim().length > 0) {
      system = override.trim();
    }
  }

  const extra = config?.additionalInstructions?.trim();
  if (extra) {
    system = `${system}${APPENDED_HEADER}${extra}`;
  }

  return system;
}

// ── Baseline builders ────────────────────────────────────────────────────────
// The canonical text of every platform prompt the registry still owns.

/** Conversation auto-titler (overridable — pure content). */
export function conversationTitlePrompt(): string {
  return "You are a conversation titler. Respond with a concise title (≤6 words, Title Case, no trailing punctuation) that captures the main topic of the user message. Return only the title.";
}
