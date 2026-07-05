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
// Type-only import — erased at compile time, so this never pulls @oxagen/billing's
// Stripe/DB-touching barrel into the client bundle (see budget-control.tsx for
// the same rationale on the literal mode copy).
import type { TurnBudgetMode } from "@oxagen/billing";

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
  /**
   * Per-turn dollar budget (OXA — turn-budget). Off by default. Seeded from
   * the user's saved default (`budget.policy.read`) at mount time; the
   * composer's BudgetControl lets the user override it per-turn or save a new
   * default via `budget.policy.write`. Mirrors `TurnBudgetPolicy` in
   * @oxagen/billing field-for-field, but kept as separate top-level fields
   * (not a nested object) so it composes with the rest of the flat
   * ComposerModelState the same way tier/model/effort do.
   */
  budgetEnabled: boolean;
  /** Per-turn ceiling in USD; null when no limit is set (mirrors the
   * budget.policy contracts' `limitUsd: number | null`). Ignored when
   * `budgetEnabled` is false. */
  budgetUsd: number | null;
  /** What happens at the ceiling — see TURN_BUDGET_MODES in @oxagen/billing. */
  budgetMode: TurnBudgetMode;
  /** `grace` mode only: fraction ABOVE `budgetUsd` allowed before a hard stop. */
  budgetGracePct: number;
}

// Mirrors TURN_BUDGET_OFF / DEFAULT_TURN_BUDGET_MODE / DEFAULT_GRACE_OVERAGE_PCT
// in @oxagen/billing as literals — this module must stay dependency-light (it
// is imported by client composer code), so the off-state defaults are copied
// here rather than importing the value from the Stripe/DB-touching billing
// barrel. Keep byte-identical to packages/billing/src/turn-budget.ts.
const BUDGET_OFF_DEFAULTS = {
  budgetEnabled: false,
  budgetUsd: null as number | null,
  budgetMode: "prompt" as TurnBudgetMode,
  budgetGracePct: 0.25,
};

export const defaultModelState: ComposerModelState = {
  generate: null,
  tier: "fast",
  model: null,
  effort: "medium",
  mediaTier: "basic",
  mediaModel: null,
  seededImageModel: null,
  seededVideoModel: null,
  ...BUDGET_OFF_DEFAULTS,
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
  /**
   * The user's saved per-turn budget default (`budget.policy.read`), resolved
   * server-side. Null/omitted degrades to the off state (BUDGET_OFF_DEFAULTS)
   * so a failed read never blocks the chat page from rendering.
   */
  budget?: {
    enabled: boolean;
    limitUsd: number | null;
    mode: TurnBudgetMode;
    graceOveragePct: number;
  } | null;
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
    budgetEnabled: seed.budget?.enabled ?? BUDGET_OFF_DEFAULTS.budgetEnabled,
    budgetUsd: seed.budget?.enabled ? (seed.budget.limitUsd ?? null) : null,
    budgetMode: seed.budget?.mode ?? BUDGET_OFF_DEFAULTS.budgetMode,
    budgetGracePct: seed.budget?.graceOveragePct ?? BUDGET_OFF_DEFAULTS.budgetGracePct,
  };
}
