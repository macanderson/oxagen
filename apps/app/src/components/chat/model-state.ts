// Composer model-state shape + pure helpers.
//
// This module is deliberately NOT a "use client" module and imports nothing
// client-only: the server component that renders the chat shell
// (`_shared/conversation-page.tsx`) calls `buildSeededModelState()` at request
// time to seed the picker from effective model defaults (workspace > user >
// system). A `"use client"` module's function exports become client references
// when imported by a server component and throw if called there, so the pure
// state logic lives here and `model-picker.tsx` re-exports it for client code.
import type { TextTier, MediaTier, MediaKind, EffortLevel } from "@oxagen/ai/catalog";

export interface ComposerModelState {
  /** null = text chat, "image"/"video" = media generation */
  generate: MediaKind | null;
  /** Selected text tier (mutually exclusive with `model`) */
  tier: TextTier | null;
  /** Explicit "Other Models" gateway model id for text */
  model: string | null;
  /** Reasoning level (text only) */
  effort: EffortLevel | null;
  /** Selected media tier */
  mediaTier: MediaTier | null;
  /** Explicit "Other Models" gateway model id for media */
  mediaModel: string | null;
  /**
   * Internal seed memory — the workspace/user preferred image model id
   * seeded at mount time. NOT serialized into the request payload; only used
   * to pre-fill `mediaModel` when the user switches INTO image mode.
   */
  seededImageModel: string | null;
  /**
   * Internal seed memory — the workspace/user preferred video model id
   * seeded at mount time. NOT serialized into the request payload; only used
   * to pre-fill `mediaModel` when the user switches INTO video mode.
   */
  seededVideoModel: string | null;
}

export const defaultModelState: ComposerModelState = {
  generate: null,
  tier: "fast",
  model: null,
  effort: "medium",
  mediaTier: "basic",
  mediaModel: null,
  seededImageModel: null,
  seededVideoModel: null,
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
  /** Image model id to pre-select in image-generation mode. */
  imageModel: string | null;
  /** Video model id to pre-select in video-generation mode. */
  videoModel: string | null;
}

/** Build the initial ComposerModelState from seeded effective defaults. */
export function buildSeededModelState(seed: ModelStateSeed): ComposerModelState {
  return {
    generate: null,
    tier: seed.textModel ? null : (seed.textTier ?? "fast"),
    model: seed.textModel ?? null,
    effort: "medium",
    // Start in text mode with no media model active. The seeded image/video
    // model ids are stored in seededImageModel / seededVideoModel so that
    // toggleGenerate() can pre-fill mediaModel the moment the user enters
    // image or video mode.
    mediaTier: "basic",
    mediaModel: null,
    seededImageModel: seed.imageModel ?? null,
    seededVideoModel: seed.videoModel ?? null,
  };
}
