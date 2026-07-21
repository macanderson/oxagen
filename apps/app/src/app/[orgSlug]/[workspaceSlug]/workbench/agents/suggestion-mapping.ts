/**
 * suggestion-mapping.ts — pure, client-safe translation from an
 * agent.definition.suggest suggestion into the Agent Builder's flat useState
 * shape.
 *
 * Extracted from agent-builder.tsx so the mapping is unit-testable without
 * mounting the wizard. This module imports only types (erased at build time)
 * and the two literal agentType discriminators, so it stays free of the
 * server-only kernel and safe to import from a "use client" component.
 */
import type {
  AgentSuggestion,
  AgentRecommendation,
  AgentSuggestedRole,
} from "@/lib/workbench/agents";

/**
 * Re-exported through this client-safe module so the "use client" wizard imports
 * the recommendation shape without reaching into the server-only agents.ts. A
 * recommendation is NOT wizard state — it never becomes a prefill field (the
 * agent can't equip what isn't available yet); the builder holds it in
 * component state next to the rationale/warnings and renders it as a
 * "connect this next" panel.
 */
export type { AgentRecommendation, AgentSuggestedRole };

// Client-safe mirror of CODING_AGENT_TYPE from lib/workbench/agents.ts (server-only).
// Keep in sync with agent-builder.tsx.
const CODING_AGENT_TYPE = "code";

/**
 * Client-safe mirror of DEFAULT_AGENT_ROLE_NAME from
 * packages/agent/src/handlers/_agent-role.ts (server-only): the role the
 * backend auto-assigns to every newly created agent, and the fallback whenever
 * a suggestion carries no `suggestedRole`. Keep in sync with agent-builder.tsx.
 */
export const DEFAULT_AGENT_ROLE_NAME = "Agent Contributor";

/**
 * The Agent Builder's editable state, flattened. Every field maps 1:1 to a
 * useState setter in the wizard so applying a prefill is a straight fan-out.
 */
export interface BuilderPrefill {
  name: string;
  slug: string;
  description: string;
  codeFeatures: boolean;
  instructions: string;
  agentTools: AgentSuggestion["config"]["agentTools"];
  ontologyId: string;
  graphMode: "read" | "extend";
  strategy: "semantic" | "lexical" | "hybrid" | "explicit";
  maxHops: number;
  maxNodes: number;
  manualEnabled: boolean;
  scheduleCron: string;
  eventSource: string;
  eventType: string;
  eventConnection: string;
  /**
   * The Access step's role pre-selection (Agent RBAC Phase 5b). Always a
   * concrete name — the suggested role when the contract returned one, else
   * DEFAULT_AGENT_ROLE_NAME, which is exactly what the backend auto-assigns on
   * create. Like every other prefill field it is only a starting point: the
   * user can pick any other role in the picker, and `assign_agent_role`
   * re-validates whatever they land on.
   */
  roleName: string;
}

/**
 * Map an AI suggestion into the builder's editable state. Every value is a
 * starting point the user can override in the normal steps — this function only
 * decides the pre-filled defaults, never persists anything.
 *
 * Trigger handling mirrors the builder's own initial-state logic: a suggestion
 * with no triggers defaults to manual-enabled (the safe default), and the first
 * schedule/event trigger populates the single cron / event row the UI exposes.
 *
 * `suggestedRole` is the sibling output field, not part of `suggestion` — it is
 * passed separately and is optional, so a caller (or a contract build) without
 * it falls back to "Agent Contributor" rather than leaving the role unset.
 */
export function mapSuggestionToPrefill(
  suggestion: AgentSuggestion,
  suggestedRole?: AgentSuggestedRole,
): BuilderPrefill {
  const config = suggestion.config;
  const triggers = config.triggers ?? [];
  const schedule = triggers.find((t) => t.type === "schedule");
  const event = triggers.find((t) => t.type === "event");
  const hasManual = triggers.some((t) => t.type === "manual");

  return {
    name: suggestion.name,
    slug: suggestion.slug,
    description: suggestion.description ?? "",
    codeFeatures: suggestion.agentType === CODING_AGENT_TYPE,
    instructions: config.instructions ?? "",
    agentTools: config.agentTools ?? [],
    ontologyId: config.graph?.ontologyId ?? "",
    graphMode: config.graph?.mode ?? "read",
    strategy: config.graph?.retrieval?.strategy ?? "hybrid",
    maxHops: config.graph?.budget?.maxHops ?? 2,
    maxNodes: config.graph?.budget?.maxNodes ?? 40,
    // No explicit triggers → manual (the builder's own default for a blank agent).
    manualEnabled: triggers.length === 0 ? true : hasManual,
    scheduleCron: schedule?.schedule ?? "",
    eventSource: event?.eventSource ?? "",
    eventType: event?.eventType ?? "",
    eventConnection: event?.connectionId ?? "",
    roleName: suggestedRole?.roleName ?? DEFAULT_AGENT_ROLE_NAME,
  };
}

// ── Role pre-selection: the deterministic layer is the authority ──────────────

/** The minimum a role option must expose for the pre-selection check. Kept
 *  structural so this module never imports the server-only agent-roles.ts. */
export interface SelectableRole {
  roleName: string;
  /** False when the role grants more than the viewer holds themselves. */
  withinCeiling: boolean;
}

export interface ResolvedSuggestedRole {
  /** The role that may actually be pre-selected. */
  roleName: string;
  /**
   * True only when the AI's choice survived validation. False means the value
   * was refused and replaced by the backend default — so the UI must NOT
   * attribute the selection to the AI or show its reasoning, which would be
   * explaining a role the user is not on.
   */
  aiSelected: boolean;
}

/**
 * Validate an AI-suggested role against the picker's REAL options before it is
 * allowed to become the selection.
 *
 * The AI-assisted path is an accelerator over the same form, never a bypass
 * around it: a suggested role the org does not offer, or one sitting above the
 * viewer's own delegation ceiling, is refused here and the selection falls back
 * to `DEFAULT_AGENT_ROLE_NAME` — exactly what the picker preselects with no AI
 * involved. `assign_agent_role` re-enforces every one of these rules
 * server-side; this is the UI half of the same policy, never a substitute.
 *
 * An empty options list means the role read degraded (rolesError): there is
 * nothing to validate against, so the suggestion is kept and the contract is
 * left as the sole authority at save time.
 */
export function resolveSuggestedRole(
  roleName: string,
  options: readonly SelectableRole[],
): ResolvedSuggestedRole {
  if (options.length === 0) return { roleName, aiSelected: true };
  const option = options.find((o) => o.roleName === roleName);
  if (option && option.withinCeiling) return { roleName, aiSelected: true };
  return { roleName: DEFAULT_AGENT_ROLE_NAME, aiSelected: false };
}

// ── Role persistence plan (what a draft save actually writes) ─────────────────

export interface RoleAssignmentPlan {
  /** The role to attach, or null when the selection already matches what is
   *  persisted and nothing needs to be written. */
  assign: string | null;
  /** The role to detach afterwards — omitted when there is none to replace. */
  revoke?: string;
}

/**
 * Decide what a draft save must write for the Access step's role selection.
 *
 * A freshly-created agent already holds DEFAULT_AGENT_ROLE_NAME (the backend
 * auto-assigns it on `agent.definition.create`), so a suggestion that landed on
 * "Agent Contributor" — including the fallback when no `suggestedRole` came
 * back — writes nothing at all. Any other selection, AI-suggested or picked by
 * hand, goes through the SAME `assign_agent_role` path Phase 5a established;
 * there is no second assignment mechanism for AI-drafted agents.
 */
export function planRoleAssignment(input: {
  selectedRoleName: string;
  /** The role currently persisted on the agent — DEFAULT_AGENT_ROLE_NAME right
   *  after a create, the loaded assignment on an edit, null for a pre-RBAC
   *  agent that holds none. */
  persistedRoleName: string | null;
}): RoleAssignmentPlan {
  const { selectedRoleName, persistedRoleName } = input;
  if (selectedRoleName === persistedRoleName) return { assign: null };
  return {
    assign: selectedRoleName,
    ...(persistedRoleName !== null ? { revoke: persistedRoleName } : {}),
  };
}
