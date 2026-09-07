/**
 * session-state.ts — the ONE chat session model (chat_ux_v2).
 *
 * Every run-context setting a conversation has — agent, model, effort, budget
 * cap — lives in this single state object with a single reducer
 * (`applySessionPatch`) as the only write path. The header subtitle, the
 * SessionSettings surface, and the actual run payload are all projections of
 * one store value, so a mismatch between what the UI shows and what the turn
 * runs with is structurally impossible: there is nothing else to disagree with.
 *
 * ADR-041 removed the code half of this model (org / repo / branch / sandbox
 * environment, the per-agent code memory, and the durable code binding):
 * Oxagen governs agents, it does not run them, so a conversation is no longer
 * grounded in a repository.
 *
 * This module is pure (no React, no "use client") so the reducer, seeding,
 * cascade, and persistence codecs are unit-testable in isolation and callable
 * from server components. The React provider lives in `session-store.tsx`.
 */
import type { EffortLevel, TextTier } from "@oxagen/ai/catalog";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ChatSessionState {
  /** Selected agent public id (`agt_…`), or null for the default assistant. */
  agentId: string | null;
  /** Text tier — mutually exclusive with `model` (explicit id wins). */
  tier: TextTier | null;
  /** Explicit gateway model id; null = use `tier`. */
  model: string | null;
  /** Reasoning effort. The v2 UI exposes low | medium | high. */
  effort: EffortLevel;
  /**
   * Per-turn budget cap in USD; null = no cap. v2 semantics are always
   * "prompt": pause and ask before a reply exceeds the cap.
   */
  budgetUsd: number | null;
}

export const SESSION_STATE_VERSION = 1;

/** Budget preset chips, in USD. "Custom" is any other value. */
export const BUDGET_PRESETS_USD = [0.5, 1, 2, 5] as const;
export const BUDGET_MIN_USD = 0.05;
export const BUDGET_STEP_USD = 0.25;

export const defaultChatSessionState: ChatSessionState = {
  agentId: null,
  tier: "fast",
  model: null,
  effort: "medium",
  budgetUsd: null,
};

// ---------------------------------------------------------------------------
// The single write path
// ---------------------------------------------------------------------------

export type ChatSessionPatch = Partial<ChatSessionState>;

/**
 * Apply a patch. The one rule left is model/tier exclusivity: an explicit
 * `model` clears `tier` and vice versa.
 *
 * Every mutation in the app goes through here — the reducer IS the write path,
 * so the rule can never be skipped by a stray setState.
 */
export function applySessionPatch(
  state: ChatSessionState,
  patch: ChatSessionPatch,
): ChatSessionState {
  const next: ChatSessionState = {
    ...state,
    ...patch,
  };

  // Model / tier exclusivity — an explicit choice of one clears the other.
  if (
    patch.model !== undefined &&
    patch.model !== null &&
    patch.tier === undefined
  ) {
    next.tier = null;
  }
  if (
    patch.tier !== undefined &&
    patch.tier !== null &&
    patch.model === undefined
  ) {
    next.model = null;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SessionSeed {
  /** Workspace user's default agent (`agt_…`), if any. */
  defaultAgentId: string | null;
  /** Effective model defaults (workspace > user > system). */
  textModel: string | null;
  textTier: TextTier | null;
  /** The user's saved per-turn budget default, already governance-clamped. */
  budgetUsd: number | null;
}

/**
 * Build the workspace-default session state for a brand-new conversation.
 * This snapshot doubles as the "Reset to defaults" target and the baseline
 * for the cog's non-default accent dot.
 */
export function seedSessionState(seed: SessionSeed): ChatSessionState {
  return {
    ...defaultChatSessionState,
    agentId: seed.defaultAgentId,
    tier: seed.textModel ? null : (seed.textTier ?? "fast"),
    model: seed.textModel,
    budgetUsd: seed.budgetUsd,
  };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** Which parts of the session are locked, and why. */
export interface SessionLocks {
  /** Agent is locked after the conversation's first message. */
  agent: boolean;
}

export function computeSessionLocks(args: {
  hasMessages: boolean;
}): SessionLocks {
  return { agent: args.hasMessages };
}

/**
 * True when any setting differs from the workspace-default seed — drives the
 * cog's accent dot.
 */
export function sessionDiffersFromDefaults(
  state: ChatSessionState,
  defaults: ChatSessionState,
): boolean {
  return (
    state.agentId !== defaults.agentId ||
    state.tier !== defaults.tier ||
    state.model !== defaults.model ||
    state.effort !== defaults.effort ||
    state.budgetUsd !== defaults.budgetUsd
  );
}

/**
 * The header-subtitle projection — the ONLY read-only echo of session state
 * allowed anywhere. Renders as `{model}` alone, or `{model} · {budget}` when a
 * per-turn cap is set.
 */
export interface SessionSubtitleParts {
  model: string;
  /** Formatted per-turn cap (e.g. "$1.00 cap"), or null when uncapped. */
  budget: string | null;
}

export function sessionSubtitleParts(
  state: ChatSessionState,
  options: {
    /** Display name for the resolved model/tier (from the model catalog). */
    modelLabel: string;
  },
): SessionSubtitleParts {
  return {
    model: options.modelLabel,
    budget:
      state.budgetUsd !== null ? `$${state.budgetUsd.toFixed(2)} cap` : null,
  };
}

// ---------------------------------------------------------------------------
// Persistence codecs (localStorage payloads)
// ---------------------------------------------------------------------------

const KEY_ROOT = "oxagen:chat-session:v1";
export const SESSION_DRAFT_PREFIX = `${KEY_ROOT}:draft:`;

/** Per-conversation storage key (draft key before the conversation exists). */
export function sessionStorageKey(
  workspaceSlug: string | undefined,
  conversationId: string | null,
): string {
  if (conversationId) return `${KEY_ROOT}:conv:${conversationId}`;
  return `${SESSION_DRAFT_PREFIX}${workspaceSlug ?? "_"}`;
}

const EFFORTS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const TIERS: readonly TextTier[] = ["fast", "balanced", "precise"];

/**
 * Decode a persisted state. Tolerant field-by-field: an unknown/corrupt field
 * falls back to the provided base (the seeded defaults) rather than throwing
 * or discarding the rest — a bad byte in storage must never brick a chat.
 */
export function decodeSessionState(
  raw: string | null,
  base: ChatSessionState,
): ChatSessionState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== SESSION_STATE_VERSION) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    agentId: str(obj.agentId),
    tier: TIERS.includes(obj.tier as TextTier)
      ? (obj.tier as TextTier)
      : obj.tier === null
        ? null
        : base.tier,
    model: str(obj.model),
    effort: EFFORTS.includes(obj.effort as EffortLevel)
      ? (obj.effort as EffortLevel)
      : base.effort,
    budgetUsd:
      typeof obj.budgetUsd === "number" && obj.budgetUsd >= BUDGET_MIN_USD
        ? obj.budgetUsd
        : null,
  };
}

export function encodeSessionState(state: ChatSessionState): string {
  return JSON.stringify({ v: SESSION_STATE_VERSION, ...state });
}
