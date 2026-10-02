// Composer model-state shape + pure helpers.
//
// This module is deliberately NOT a "use client" module and imports nothing
// client-only: the server component that renders the chat shell
// (`_shared/conversation-page.tsx`) calls `buildSeededModelState()` at request
// time to seed the picker from effective model defaults (workspace > user >
// system). A `"use client"` module's function exports become client references
// when imported by a server component and throw if called there, so the pure
// state logic lives here and `model-picker.tsx` re-exports it for client code.
import type { TextTier, EffortLevel } from "@oxagen/ai/catalog";

// ADR-043 removed image and video generation, so a composer turn is text +
// reasoning effort and nothing else — there is no generate mode, no media tier
// and no media model to carry.
export interface ComposerModelState {
  /** Selected text tier (mutually exclusive with `model`) */
  tier: TextTier | null;
  /** Explicit "Other Models" gateway model id */
  model: string | null;
  /** Reasoning level */
  effort: EffortLevel | null;
}

export const defaultModelState: ComposerModelState = {
  tier: "fast",
  model: null,
  effort: "medium",
};

/**
 * Seed properties for ComposerModelState derived from effective model defaults
 * resolved server-side (workspace > user > system). Passed once at mount time;
 * the user can still override per-turn via the ModelPicker.
 */
export interface ModelStateSeed {
  /** Explicit text model id to pre-select (wins over tier when set). */
  textModel: string | null;
  /** Text tier to pre-select (used only when textModel is null). */
  textTier: TextTier | null;
}

/** Build the initial ComposerModelState from seeded effective defaults. */
export function buildSeededModelState(
  seed: ModelStateSeed,
): ComposerModelState {
  return {
    tier: seed.textModel ? null : (seed.textTier ?? "fast"),
    model: seed.textModel ?? null,
    effort: "medium",
  };
}
