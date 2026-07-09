/**
 * workbench/agents.ts — server-side wrappers over the agent.definition.* contracts.
 *
 * These are thin, typed calls into the kernel via invoke() with the Workbench
 * scope/IAM already resolved. Read helpers (list/get) are safe to call from
 * RSC; mutations (create/update/publish/deploy) are called from "use server"
 * action files. All use surface:"agent" because the agent.definition.* and
 * agent.tool.list contracts list "agent" in their surfaces.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import type {
  AgentDefinitionConfig,
} from "@oxagen/oxagen/agent-schema";
import type { AgentDefinitionSuggestOutput } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import type { WorkbenchCtx } from "./scope";

// A single AI-generated agent configuration, shaped exactly like
// agent.definition.create input. Re-exported from the contract so the action
// and the client mapping speak the same type.
export type AgentSuggestion = AgentDefinitionSuggestOutput["suggestion"];

/**
 * A single "connect this next" recommendation — an MCP server from the synced
 * registry catalog or a disabled workspace skill the agent should have but that
 * is NOT yet available (so it is never in suggestion.config.agentTools). The
 * caller connects/enables it, then equips it. Contract-derived so the action,
 * the builder, and the panel all speak the same shape.
 */
export type AgentRecommendation =
  AgentDefinitionSuggestOutput["recommendations"][number];

export type SuggestAgentResult = {
  suggestion: AgentSuggestion;
  rationale: string;
  warnings: string[];
  recommendations: AgentRecommendation[];
};

// ── Types mirrored from the agent.definition.* contract outputs ───────────────

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
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  latestVersion: number | null;
  managed: boolean;
};

export type AgentDetail = {
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
  agentType: string;
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  version: number | null;
  isPublished: boolean;
  managed: boolean;
  config: AgentDefinitionConfig;
};

/**
 * Code features are not a first-class column on AgentDefinition. We persist the
 * flag on the identity row's agentType: "code" enables the sandbox/coding path
 * at launch, "custom" is a plain conversational/tool agent. This keeps the
 * feature real with zero schema migration (see 04-build-plan-and-prompts.md).
 *
 * "code" is the platform convention (aligns with the chat composer's code-mode
 * gate). isCodingAgent stays read-tolerant of the earlier "coding" spelling so
 * agents created before the convention settled still enable the coding path.
 */
export const CODING_AGENT_TYPE = "code";
export const DEFAULT_AGENT_TYPE = "custom";

export function isCodingAgent(agentType: string): boolean {
  return agentType === CODING_AGENT_TYPE || agentType === "coding";
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listAgents(
  ctx: WorkbenchCtx,
  status?: "draft" | "active" | "archived",
): Promise<AgentListRow[]> {
  const out = (await invoke(
    "list_agent_defs",
    { status },
    ctx,
    { surface: "agent" },
  )) as { agents: AgentListRow[] };
  return out.agents;
}

export async function getAgent(
  ctx: WorkbenchCtx,
  agentId: string,
): Promise<AgentDetail> {
  return (await invoke(
    "get_agent_def",
    { agentId },
    ctx,
    { surface: "agent" },
  )) as AgentDetail;
}

/**
 * AI-assisted setup: turn a plain-language description into a complete draft
 * agent configuration. Nothing is persisted — the caller reviews the suggestion
 * in the builder and saves the draft explicitly. surface:"agent" because
 * agent.definition.suggest lists "agent" in its surfaces.
 */
export async function suggestAgentDefinition(
  ctx: WorkbenchCtx,
  input: { description: string; nameHint?: string; agentTypeHint?: string },
): Promise<SuggestAgentResult> {
  return (await invoke(
    "suggest_agent_def",
    input,
    ctx,
    { surface: "agent" },
  )) as SuggestAgentResult;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export type CreateAgentInput = {
  slug: string;
  name: string;
  description?: string;
  agentType?: string;
  config: AgentDefinitionConfig;
};

export async function createAgent(
  ctx: WorkbenchCtx,
  input: CreateAgentInput,
): Promise<{ agentId: string; publicId: string; slug: string; version: number }> {
  return (await invoke(
    "create_agent_def",
    {
      slug: input.slug,
      name: input.name,
      description: input.description,
      agentType: input.agentType ?? DEFAULT_AGENT_TYPE,
      config: input.config,
    },
    ctx,
    { surface: "agent" },
  )) as { agentId: string; publicId: string; slug: string; version: number };
}

export type UpdateAgentInput = {
  agentId: string;
  name?: string;
  description?: string;
  /**
   * Optional agentType change (e.g. flip code features on/off after creation).
   * Requires the agent.definition.update contract to accept agentType — added
   * as part of the Agent Workbench work package.
   */
  agentType?: string;
  config: AgentDefinitionConfig;
};

export async function updateAgent(
  ctx: WorkbenchCtx,
  input: UpdateAgentInput,
): Promise<{ agentId: string; version: number; isPublished: boolean }> {
  return (await invoke(
    "update_agent_def",
    input,
    ctx,
    { surface: "agent" },
  )) as { agentId: string; version: number; isPublished: boolean };
}

export async function publishAgent(
  ctx: WorkbenchCtx,
  agentId: string,
  version?: number,
): Promise<{ agentId: string; version: number; checksum: string }> {
  return (await invoke(
    "publish_agent_def",
    { agentId, version },
    ctx,
    { surface: "agent" },
  )) as { agentId: string; version: number; checksum: string };
}

export async function deployAgent(
  ctx: WorkbenchCtx,
  agentId: string,
  deploymentStatus: "inactive" | "active",
): Promise<{ agentId: string; deploymentStatus: "inactive" | "active" }> {
  return (await invoke(
    "deploy_agent",
    { agentId, deploymentStatus },
    ctx,
    { surface: "agent" },
  )) as { agentId: string; deploymentStatus: "inactive" | "active" };
}
