// Composer model-state shape + pure helpers.
//
// This module is deliberately NOT a "use client" module and imports nothing
// client-only: the server component that renders the chat shell
// (`_shared/conversation-page.tsx`) calls `buildSeededModelState()` at request
// time to seed the picker from effective model defaults (workspace > user >
// system). A `"use client"` module's function exports become client references
// when imported by a server component and throw if called there, so the pure
// state logic lives here and `model-picker.tsx` re-exports it for client code.
import type {
  TextTier,
  MediaTier,
  MediaKind,
  EffortLevel,
} from "@oxagen/ai/catalog";
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
export function buildSeededModelState(
  seed: ModelStateSeed,
): ComposerModelState {
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
    budgetGracePct:
      seed.budget?.graceOveragePct ?? BUDGET_OFF_DEFAULTS.budgetGracePct,
  };
}

// ── Workspace budget governance ──────────────────────────────────
// A workspace Owner/Admin may impose a governed budget on top of a member's
// own per-turn budget — mirrors `GovernedBudget`/`resolveEffectiveTurnBudget`
// in @oxagen/billing, but kept as a small dependency-light local type (same
// rationale as BUDGET_OFF_DEFAULTS above: this module is imported by client
// composer code, so it must not drag in @oxagen/billing's Stripe/DB-touching
// value exports — only types are ever imported from it here).

/** Resolved via `workspace.budget.policy.read`, server-side. `enabled: false`
 * means no governance is active for this workspace. */
export interface WorkspaceBudgetGovernance {
  enabled: boolean;
  /** Governed limit in USD. Ignored when `enabled` is false. */
  limitUsd: number;
  mode: TurnBudgetMode;
  /** "ceiling" = hard cap the member cannot exceed; "default" = soft seed the
   * member may override in either direction. */
  enforcement: "default" | "ceiling";
}

/** Strictness rank of a mode — mirrors MODE_STRICTNESS in
 * packages/billing/src/turn-budget.ts (enforce > prompt > grace). */
const MODE_STRICTNESS: Record<TurnBudgetMode, number> = {
  grace: 0,
  prompt: 1,
  enforce: 2,
};

/**
 * Apply workspace budget governance to a composer state — the CLIENT-SIDE
 * mirror of `resolveEffectiveTurnBudget`'s precedence in @oxagen/billing,
 * scoped to what the composer UI needs to reflect/enforce:
 *
 *   - No governance (`null`, or `enabled: false`) ⇒ state is untouched.
 *   - `"default"` (soft seed) ⇒ only applies when the member hasn't opted
 *     into their own budget yet (`!state.budgetEnabled`); once a member has a
 *     budget on, their own choice always stands.
 *   - `"ceiling"` (hard cap) ⇒ ALWAYS applies: forces the budget on, clamps
 *     the limit down to `min(current, ceiling)`, and clamps the mode up to
 *     whichever of (current, ceiling) is stricter. A member can still set a
 *     TIGHTER limit/mode than the ceiling — this only ever pulls a looser
 *     choice back down, never loosens one.
 *
 * The server is still the source of truth (route.ts re-runs the equivalent
 * merge via resolveEffectiveTurnBudget before enforcing) — this only keeps
 * the composer's displayed/submitted values from ever claiming a laxer
 * budget than the workspace actually allows, so the UI doesn't lie to the
 * user about what will happen.
 */
export function applyWorkspaceBudgetGovernance(
  state: ComposerModelState,
  governance: WorkspaceBudgetGovernance | null,
): ComposerModelState {
  if (!governance || !governance.enabled || governance.limitUsd <= 0)
    return state;

  if (governance.enforcement === "default") {
    if (state.budgetEnabled) return state;
    return {
      ...state,
      budgetEnabled: true,
      budgetUsd: governance.limitUsd,
      budgetMode: governance.mode,
    };
  }

  // "ceiling" — always clamp, never loosen.
  const currentLimit =
    state.budgetEnabled && state.budgetUsd && state.budgetUsd > 0
      ? state.budgetUsd
      : Number.POSITIVE_INFINITY;
  const clampedLimit = Math.min(currentLimit, governance.limitUsd);
  const currentMode = state.budgetEnabled ? state.budgetMode : governance.mode;
  const clampedMode =
    MODE_STRICTNESS[governance.mode] >= MODE_STRICTNESS[currentMode]
      ? governance.mode
      : currentMode;
  return {
    ...state,
    budgetEnabled: true,
    budgetUsd: Number.isFinite(clampedLimit)
      ? clampedLimit
      : governance.limitUsd,
    budgetMode: clampedMode,
  };
}
