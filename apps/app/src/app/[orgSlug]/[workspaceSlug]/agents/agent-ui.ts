/**
 * agent-ui.ts — pure presentational helpers shared across the Agents surface.
 *
 * No React, no server imports — node-testable. Keeps badge styling, default
 * config construction, and slug derivation in one place so the list, detail,
 * create, and edit surfaces stay consistent.
 */
import type { AgentDefinitionConfig } from "@oxagen/oxagen/agent-schema";

export type AgentLifecycleStatus = "draft" | "active" | "archived";
export type AgentDeploymentStatus = "inactive" | "active";

export const LIFECYCLE_BADGE: Record<
  AgentLifecycleStatus,
  { label: string; variant: "secondary" | "success" | "muted" }
> = {
  draft: { label: "Draft", variant: "secondary" },
  active: { label: "Active", variant: "success" },
  archived: { label: "Archived", variant: "muted" },
};

export const DEPLOYMENT_BADGE: Record<
  AgentDeploymentStatus,
  { label: string; variant: "success" | "outline" }
> = {
  active: { label: "Deployed", variant: "success" },
  inactive: { label: "Not deployed", variant: "outline" },
};

/**
 * Derive a kebab-case slug from a free-text name. Lowercases, replaces runs of
 * non-alphanumerics with a single hyphen, and trims leading/trailing hyphens.
 * Mirrors the create-contract slug regex (^[a-z0-9]+(-[a-z0-9]+)*$).
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A sensible default config for a brand-new agent (read-only, hybrid retrieval). */
export function defaultAgentConfig(ontologyId: string): AgentDefinitionConfig {
  return {
    graph: {
      ontologyId,
      mode: "read",
      retrieval: { strategy: "hybrid" },
      budget: { maxHops: 3, maxNodes: 50, minRelevance: 0.5 },
    },
    agentTools: [],
    triggers: [],
    instructions: "",
  };
}

/** Human label for an agent tool type. */
export const TOOL_TYPE_LABEL: Record<string, string> = {
  function: "Function",
  mcp_server: "MCP server",
  skill: "Skill",
  agent: "Subagent",
};

/** Human label for a trigger type. */
export const TRIGGER_TYPE_LABEL: Record<string, string> = {
  manual: "Manual",
  schedule: "Schedule",
  event: "Event",
};

/**
 * Build a one-line summary of a trigger for table/list display.
 */
export function summarizeTrigger(trigger: {
  triggerType: string;
  eventSource?: string | null;
  eventType?: string | null;
  schedule?: string | null;
}): string {
  switch (trigger.triggerType) {
    case "schedule":
      return trigger.schedule ? `cron: ${trigger.schedule}` : "schedule";
    case "event":
      return [trigger.eventSource, trigger.eventType].filter(Boolean).join(" · ") || "event";
    default:
      return "manual invocation";
  }
}
