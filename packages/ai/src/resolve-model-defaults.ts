// Client-safe model default resolver — no provider-SDK or DB imports.
// Exported from both "@oxagen/ai/catalog" (client) and "@oxagen/ai" (server).
//
// Precedence per dimension:
//   workspace value ?? user value ?? null
//
// The text dimension resolves `model` and `tier` on two INDEPENDENT chains:
//   text.model = workspace.model ?? user.model ?? null
//   text.tier  = workspace.tier  ?? user.tier  ?? null
//
// Both are returned. Deciding which one wins is the CALLER's job, and every
// caller today prefers `text.model` over `text.tier` (see the chat stream
// routes). That means a user-level `defaultTextModel` beats a workspace-level
// `defaultTextTier`, even though `overriddenByWorkspace.text` is true — the flag
// reports that the workspace set something, not that the workspace won. A
// workspace that wants to force a model must set `defaultTextModel`, not a tier.

/**
 * Model-tier string union — mirrors the auth.model_tier Postgres enum.
 * Declared locally to keep this module fully client-safe (no @oxagen/database
 * import at all, not even type-only, since the database package's entry point
 * may reference server-only modules in some bundler configurations).
 */
export type ModelTier = "fast" | "balanced" | "precise";

export interface ModelDefaultsInput {
  /** User-level preferences row (or null if none exists). */
  user: {
    defaultTextTier: ModelTier | null;
    defaultTextModel: string | null;
    defaultImageModel: string | null;
    defaultVideoModel: string | null;
  } | null;
  /** Workspace-level model settings (or null if no workspace context). */
  workspace: {
    defaultTextTier: ModelTier | null;
    defaultTextModel: string | null;
    defaultImageModel: string | null;
    defaultVideoModel: string | null;
  } | null;
}

export interface ResolvedModelDefaults {
  /**
   * Resolved text preferences. Both fields are resolved independently and both
   * may be set; callers pick one, and every caller today prefers `model` over
   * `tier`. See this module's header for what that means for workspace policy.
   */
  text: {
    tier: ModelTier | null;
    model: string | null;
  };
  image: { model: string | null };
  video: { model: string | null };
  /**
   * True when the workspace explicitly sets that dimension, meaning the workspace
   * setting is shadowing the user's own preference. Useful for surfacing an
   * "overridden by workspace" alert in the UI.
   */
  overriddenByWorkspace: {
    text: boolean;
    image: boolean;
    video: boolean;
  };
}

/**
 * Resolve user + workspace model defaults into a single effective configuration.
 *
 * This is a pure function with no I/O — safe to call on the client or in tests
 * without any database/provider dependencies.
 */
export function resolveModelDefaults(
  input: ModelDefaultsInput,
): ResolvedModelDefaults {
  const { user, workspace } = input;

  // ── Text dimension ─────────────────────────────────────────────────────────
  // Prefer explicit model over tier, workspace over user.
  const textModel: string | null =
    workspace?.defaultTextModel ?? user?.defaultTextModel ?? null;
  const textTier: ModelTier | null =
    workspace?.defaultTextTier ?? user?.defaultTextTier ?? null;

  // ── Image dimension ────────────────────────────────────────────────────────
  const imageModel: string | null =
    workspace?.defaultImageModel ?? user?.defaultImageModel ?? null;

  // ── Video dimension ────────────────────────────────────────────────────────
  const videoModel: string | null =
    workspace?.defaultVideoModel ?? user?.defaultVideoModel ?? null;

  // ── Override flags ─────────────────────────────────────────────────────────
  // A dimension is "overridden by workspace" when the workspace explicitly sets
  // at least one of its fields (non-null), regardless of whether the user also
  // has a preference.
  const wsOverridesText =
    (workspace?.defaultTextModel !== null &&
      workspace?.defaultTextModel !== undefined) ||
    (workspace?.defaultTextTier !== null &&
      workspace?.defaultTextTier !== undefined);

  const wsOverridesImage =
    workspace?.defaultImageModel !== null &&
    workspace?.defaultImageModel !== undefined;

  const wsOverridesVideo =
    workspace?.defaultVideoModel !== null &&
    workspace?.defaultVideoModel !== undefined;

  return {
    text: { tier: textTier, model: textModel },
    image: { model: imageModel },
    video: { model: videoModel },
    overriddenByWorkspace: {
      text: wsOverridesText,
      image: wsOverridesImage,
      video: wsOverridesVideo,
    },
  };
}
