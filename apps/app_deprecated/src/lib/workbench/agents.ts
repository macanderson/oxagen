/**
 * workbench/agents.ts — the deprecated workbench's agent seam, retired by
 * ADR-198.
 *
 * The capabilities this module wrapped (`list_agent_defs`, `get_agent_def`,
 * `suggest_agent_def`, `create_agent_def`, `update_agent_def`,
 * `summarize_agent_def`, `publish_agent_def`, `deploy_agent`) are gone: an
 * agent is now one operator on one runtime with one harness, carrying a
 * toolbelt, and it is registered in the rebuilt app (`apps/app`). The reads
 * answer an empty roster, so the deprecated builder and chat picker render
 * with no agents, and every write refuses with `AgentDefinitionsRemovedError`.
 * The exported names and types stay so the deprecated pages keep compiling.
 *
 * Server-only. Never import from a "use client" module.
 */
import type { AgentDefinitionConfig } from "@oxagen/oxagen/agent-schema";
import type { WorkbenchCtx } from "./scope";

/** Every write through this module since ADR-198. */
export class AgentDefinitionsRemovedError extends Error {
  readonly code = "agent_definitions_removed";
  constructor() {
    super(
      "Agent definitions were removed (ADR-198). Register an agent on a runtime from the Agents page.",
    );
    this.name = "AgentDefinitionsRemovedError";
  }
}

function removed(): never {
  throw new AgentDefinitionsRemovedError();
}

// A single AI-generated agent configuration, in the shape the deprecated
// builder maps into its form (`suggestion-mapping.ts`).
export type AgentSuggestion = {
  slug: string;
  name: string;
  description: string;
  agentType: string;
  config: {
    graph: AgentDefinitionConfig["graph"];
    agentTools: AgentDefinitionConfig["agentTools"];
    instructions: string;
  };
};

/** A "connect this next" recommendation the deprecated builder renders. */
export type AgentRecommendation = {
  kind: "mcp_server";
  ref: string;
  name: string;
  reason: string;
};

/** The suggested role the deprecated builder pre-selects. */
export type AgentSuggestedRole = {
  roleName: "Agent Observer" | "Agent Contributor" | "Agent Operator";
  reason: string;
};

export type SuggestAgentResult = {
  suggestion: AgentSuggestion;
  rationale: string;
  warnings: string[];
  recommendations: AgentRecommendation[];
  suggestedRole?: AgentSuggestedRole;
};

export type AgentListRow = {
  agentId: string;
  publicId: string;
  slug: string;
  /**
   * Globally-unique, immutable, human-readable agent identifier
   * (org_namespace.workspace_namespace.agent_slug). Null only pre-backfill.
   */
  agentKey: string | null;
  name: string;
  description: string | null;
  /** https:// URL or "avatar:v1:<json>" designed-avatar string; null when unset. */
  avatarUrl: string | null;
  /** LLM-inferred plain-text blurb of what the agent does; null until summarized. */
  summary: string | null;
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  latestVersion: number | null;
  managed: boolean;
};

export type AgentDetail = {
  agentId: string;
  publicId: string;
  slug: string;
  agentKey: string | null;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  summary: string | null;
  agentType: string;
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  version: number | null;
  isPublished: boolean;
  managed: boolean;
  config: AgentDefinitionConfig;
};

/** The agentType the deprecated builder wrote. Kept for its form's default. */
export const DEFAULT_AGENT_TYPE = "custom";

// ── Reads ─────────────────────────────────────────────────────────────────────

/** No agent definitions exist to list (ADR-198). */
export async function listAgents(
  _ctx: WorkbenchCtx,
  _status?: "draft" | "active" | "archived",
): Promise<AgentListRow[]> {
  return [];
}

/** No agent definition exists to read (ADR-198). */
export async function getAgent(
  _ctx: WorkbenchCtx,
  _agentId: string,
): Promise<AgentDetail> {
  return removed();
}

export async function suggestAgentDefinition(
  _ctx: WorkbenchCtx,
  _input: { description: string; nameHint?: string; agentTypeHint?: string },
): Promise<SuggestAgentResult> {
  return removed();
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export type CreateAgentInput = {
  slug: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  config: AgentDefinitionConfig;
};

export async function createAgent(
  _ctx: WorkbenchCtx,
  _input: CreateAgentInput,
): Promise<{
  agentId: string;
  publicId: string;
  slug: string;
  version: number;
}> {
  return removed();
}

export type UpdateAgentInput = {
  agentId: string;
  name?: string;
  description?: string;
  avatarUrl?: string | null;
  config: AgentDefinitionConfig;
};

export async function updateAgent(
  _ctx: WorkbenchCtx,
  _input: UpdateAgentInput,
): Promise<{ agentId: string; version: number; isPublished: boolean }> {
  return removed();
}

export async function summarizeAgent(
  _ctx: WorkbenchCtx,
  _agentId: string,
  _force?: boolean,
): Promise<{ agentId: string; summary: string; checksum: string }> {
  return removed();
}

/** Returns the rows unchanged: nothing writes an agent summary since ADR-198. */
export async function ensureAgentSummaries(
  _ctx: WorkbenchCtx,
  agents: AgentListRow[],
  _limit = 3,
): Promise<AgentListRow[]> {
  return agents;
}

export async function publishAgent(
  _ctx: WorkbenchCtx,
  _agentId: string,
  _version?: number,
): Promise<{ agentId: string; version: number; checksum: string }> {
  return removed();
}

export async function deployAgent(
  _ctx: WorkbenchCtx,
  _agentId: string,
  _deploymentStatus: "inactive" | "active",
): Promise<{ agentId: string; deploymentStatus: "inactive" | "active" }> {
  return removed();
}
