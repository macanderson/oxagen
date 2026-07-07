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
} from "@/lib/studio/agents";

// Client-safe mirror of CODING_AGENT_TYPE from lib/studio/agents.ts (server-only).
// Keep in sync with agent-builder.tsx.
const CODING_AGENT_TYPE = "code";

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
}

/**
 * Map an AI suggestion into the builder's editable state. Every value is a
 * starting point the user can override in the normal steps — this function only
 * decides the pre-filled defaults, never persists anything.
 *
 * Trigger handling mirrors the builder's own initial-state logic: a suggestion
 * with no triggers defaults to manual-enabled (the safe default), and the first
 * schedule/event trigger populates the single cron / event row the UI exposes.
 */
export function mapSuggestionToPrefill(
  suggestion: AgentSuggestion,
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
  };
}
