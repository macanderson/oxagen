/**
 * session-state.ts — the ONE chat session model (chat_ux_v2).
 *
 * Every run-context setting a conversation has — agent, model, effort, budget
 * cap, org, repo, branch, environment, output toggles — lives in this single
 * state object with a single reducer (`applySessionPatch`) as the only write
 * path. The header subtitle, the SessionSettings surface, and the actual run
 * payload are all projections of one store value, so the legacy class of
 * mismatch (Context panel showing branch `main` while the composer shows
 * `development`) is structurally impossible: there is nothing else to disagree
 * with.
 *
 * This module is pure (no React, no "use client") so the reducer, seeding,
 * cascade, and persistence codecs are unit-testable in isolation and callable
 * from server components. The React provider lives in `session-store.tsx`.
 */
import type { EffortLevel, TextTier } from "@oxagen/ai/catalog";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";

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
  /**
   * GitHub owner (user/organisation) scoping the repo picker. Kept explicit —
   * not derived from `repoKey` — so clearing the repo preserves the org and
   * the cascade rules stay one-directional (org → repo → branch).
   */
  org: string | null;
  /** Selected repo key: `${connectionId}::${owner}/${name}`. */
  repoKey: string | null;
  /** Explicit branch; null = the repo's default branch. */
  branch: string | null;
  /** Selected environment id. */
  envId: string | null;
}

/** The fields the Code section owns — remembered per agent per workspace. */
export interface CodeContextMemory {
  org: string | null;
  repoKey: string | null;
  branch: string | null;
  envId: string | null;
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
  org: null,
  repoKey: null,
  branch: null,
  envId: null,
};

// ---------------------------------------------------------------------------
// The single write path
// ---------------------------------------------------------------------------

export type ChatSessionPatch = Partial<ChatSessionState>;

/**
 * Apply a patch with the Code-section cascade rules:
 *   - changing `org` resets repo and branch;
 *   - changing `repoKey` resets branch (back to the repo default) and, unless
 *     the patch also sets it, re-derives `org` from the new repo key;
 *   - an explicit `model` clears `tier` and vice versa (they are exclusive).
 *
 * Every mutation in the app goes through here — the reducer IS the write path,
 * so the cascades can never be skipped by a stray setState.
 */
export function applySessionPatch(
  state: ChatSessionState,
  patch: ChatSessionPatch,
): ChatSessionState {
  const next: ChatSessionState = {
    ...state,
    ...patch,
  };

  if (patch.org !== undefined && patch.org !== state.org) {
    if (patch.repoKey === undefined) next.repoKey = null;
    if (patch.branch === undefined) next.branch = null;
  }
  if (patch.repoKey !== undefined && patch.repoKey !== state.repoKey) {
    if (patch.branch === undefined) next.branch = null;
    if (patch.org === undefined) {
      next.org = ownerOfRepoKey(patch.repoKey) ?? next.org;
    }
  }
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

/** Extract the GitHub owner from a `${connectionId}::${owner}/${name}` key. */
export function ownerOfRepoKey(repoKey: string | null): string | null {
  if (!repoKey) return null;
  const sep = repoKey.indexOf("::");
  if (sep < 0) return null;
  const slug = repoKey.slice(sep + 2);
  const slash = slug.indexOf("/");
  return slash > 0 ? slug.slice(0, slash) : null;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SessionSeed {
  /** Workspace user's default agent (`agt_…`), if any. */
  defaultAgentId: string | null;
  /** Workspace default repo resolved to a live key, if any. */
  defaultRepoKey: string | null;
  /** Workspace default environment id, if any. */
  defaultEnvId: string | null;
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
  const repoKey = seed.defaultRepoKey;
  return {
    ...defaultChatSessionState,
    agentId: seed.defaultAgentId,
    tier: seed.textModel ? null : (seed.textTier ?? "fast"),
    model: seed.textModel,
    budgetUsd: seed.budgetUsd,
    org: ownerOfRepoKey(repoKey),
    repoKey,
    branch: null,
    envId: seed.defaultEnvId,
  };
}

/**
 * Overlay an agent's remembered code context (last org/repo/branch/env used
 * with that agent in this workspace) onto a state — used when the user picks
 * an agent before the first message.
 */
export function applyCodeMemory(
  state: ChatSessionState,
  memory: CodeContextMemory | null,
): ChatSessionState {
  if (!memory) return state;
  return applySessionPatch(state, {
    org: memory.org,
    repoKey: memory.repoKey,
    branch: memory.branch,
    envId: memory.envId,
  });
}

/** The Code slice of a state, for writing agent memory. */
export function codeMemoryOf(state: ChatSessionState): CodeContextMemory {
  return {
    org: state.org,
    repoKey: state.repoKey,
    branch: state.branch,
    envId: state.envId,
  };
}

/**
 * Force a state onto a conversation's durable server code binding. The
 * binding is authoritative for agent + repo + environment (claimed on the
 * first code turn; the server resolves every later turn from it), so the
 * client state MUST mirror it — this is what makes the old drift impossible.
 */
export function applyCodeBinding(
  state: ChatSessionState,
  binding: StoredCodeBinding | null,
): ChatSessionState {
  if (!binding) return state;
  const repoKey = `${binding.connectionId}::${binding.owner}/${binding.name}`;
  return {
    ...state,
    agentId: binding.agentId,
    org: binding.owner,
    repoKey,
    // The binding pins the repo, not a feature branch — keep an explicit
    // branch choice if one is set, else fall back to the repo default.
    branch: state.repoKey === repoKey ? state.branch : null,
    envId: binding.environmentId,
  };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** Which parts of the session are locked, and why. */
export interface SessionLocks {
  /** Agent is locked after the conversation's first message. */
  agent: boolean;
  /** Repo/env are locked once a durable code binding exists. */
  code: boolean;
}

export function computeSessionLocks(args: {
  hasMessages: boolean;
  codeBinding: StoredCodeBinding | null;
  clientLocked: boolean;
}): SessionLocks {
  const bound = args.codeBinding !== null;
  return {
    agent: args.hasMessages || bound || args.clientLocked,
    code: bound || args.clientLocked,
  };
}

/** A broken selection (access revoked, branch deleted, env removed). */
export interface SessionSelectionIssue {
  field: "repo" | "branch" | "environment";
  /** Sentence-case, states what happened and what to do next. */
  message: string;
}

/**
 * Detect selections that no longer resolve against the live options. Branch
 * validation only runs when a branch list is actually loaded (`branches` is
 * non-null) — an unloaded list must not flag a false warning.
 */
export function sessionSelectionIssues(
  state: ChatSessionState,
  options: {
    repos: readonly RepoOption[];
    environments: readonly EnvironmentOption[];
    /** Live branch names for the selected repo, or null when not loaded. */
    branches: readonly string[] | null;
  },
): SessionSelectionIssue[] {
  const issues: SessionSelectionIssue[] = [];
  if (state.repoKey && !options.repos.some((r) => r.key === state.repoKey)) {
    issues.push({
      field: "repo",
      message:
        "This repository is no longer available. Pick another repository.",
    });
  }
  if (
    state.branch &&
    options.branches !== null &&
    !options.branches.includes(state.branch)
  ) {
    issues.push({
      field: "branch",
      message: `Branch ${state.branch} was deleted. Pick another branch.`,
    });
  }
  if (state.envId && !options.environments.some((e) => e.id === state.envId)) {
    issues.push({
      field: "environment",
      message:
        "This environment is no longer available. Pick another environment.",
    });
  }
  return issues;
}

/**
 * True when any setting differs from the workspace-default seed — drives the
 * cog's accent dot. A transient branch equal to the repo default does not count
 * (null and the literal default mean the same thing).
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
    state.budgetUsd !== defaults.budgetUsd ||
    state.org !== defaults.org ||
    state.repoKey !== defaults.repoKey ||
    (state.branch ?? null) !== (defaults.branch ?? null) ||
    state.envId !== defaults.envId
  );
}

/**
 * The header-subtitle projection — the ONLY read-only echo of session state
 * allowed anywhere. Mobile: `{model} · {branch}`. Desktop:
 * `{model} · {repo} @ {branch} · {environment}` (repo middle-ellipsis is the
 * renderer's job; this returns full values).
 */
export interface SessionSubtitleParts {
  model: string;
  repo: string | null;
  branch: string | null;
  environment: string | null;
}

export function sessionSubtitleParts(
  state: ChatSessionState,
  options: {
    repos: readonly RepoOption[];
    environments: readonly EnvironmentOption[];
    /** Display name for the resolved model/tier (from the model catalog). */
    modelLabel: string;
  },
): SessionSubtitleParts {
  const repo = state.repoKey
    ? (options.repos.find((r) => r.key === state.repoKey) ?? null)
    : null;
  const env = state.envId
    ? (options.environments.find((e) => e.id === state.envId) ?? null)
    : null;
  return {
    model: options.modelLabel,
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    branch: state.branch ?? repo?.defaultBranch ?? null,
    environment: env?.name ?? null,
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

/** Per-agent-per-workspace code-context memory key. */
export function agentMemoryKey(
  workspaceSlug: string | undefined,
  agentId: string,
): string {
  return `${KEY_ROOT}:agent:${workspaceSlug ?? "_"}:${agentId}`;
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
    org: str(obj.org),
    repoKey: str(obj.repoKey),
    branch: str(obj.branch),
    envId: str(obj.envId),
  };
}

export function encodeSessionState(state: ChatSessionState): string {
  return JSON.stringify({ v: SESSION_STATE_VERSION, ...state });
}

/** Decode an agent's remembered code context. */
export function decodeCodeMemory(raw: string | null): CodeContextMemory | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const str = (v: unknown): string | null =>
      typeof v === "string" ? v : null;
    return {
      org: str(parsed.org),
      repoKey: str(parsed.repoKey),
      branch: str(parsed.branch),
      envId: str(parsed.envId),
    };
  } catch {
    return null;
  }
}

export function encodeCodeMemory(memory: CodeContextMemory): string {
  return JSON.stringify(memory);
}
