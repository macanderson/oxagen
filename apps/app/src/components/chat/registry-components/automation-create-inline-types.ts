/**
 * automation-create-inline-types.ts — Shared types, constants, and pure factory
 * functions for the automation-create-inline chat registry component.
 */
import type { ConditionNode } from "@oxagen/oxagen/trigger-conditions";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PropertyCondition {
  property: string;
  operator: "eq" | "gt" | "lt" | "changed";
  toValue?: string;
}

export interface AutomationStep {
  name: string;
  stepType:
    | "agent"
    | "tool"
    | "condition"
    | "webhook"
    | "prompt"
    | "human_input";
  config?: Record<string, unknown>;
}

export interface AutomationCreateInlineProps {
  /** Pre-suggested automation name from the agent */
  suggestedName?: string;
  /** Pre-suggested description from the agent */
  suggestedDescription?: string;
  /** Trigger type pre-inferred by agent */
  triggerType?: "event" | "schedule" | "api";
  /** Graph entity type to watch (for 'event' triggers) */
  entityType?: string;
  /** Graph event type (for 'event' triggers) */
  eventType?: "node.created" | "node.updated" | "node.deleted";
  /** Property conditions (for 'event' triggers) — legacy flat form, seeded into the tree. */
  propertyConditions?: PropertyCondition[];
  /** Nested schema-driven condition tree (for 'event' triggers) — preferred form. */
  conditionTree?: ConditionNode;
  /** POSIX cron expression (for 'schedule' triggers) */
  cronExpression?: string;
  /** IANA timezone (for 'schedule' triggers) */
  timezone?: string;
  /** Initial steps scaffolded by the agent */
  steps?: AutomationStep[];
  /** Injected by the stream route — needed for server action context. */
  orgSlug?: string;
  workspaceSlug?: string;
}

export type FormState =
  | "editing"
  | "submitting"
  | "created"
  | "enabling"
  | "enabled"
  | "error";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TRIGGER_TYPE_OPTIONS = [
  { value: "event", label: "Graph event" },
  { value: "schedule", label: "Schedule (cron)" },
  { value: "api", label: "API / manual" },
] as const;

export const EVENT_TYPE_OPTIONS = [
  { value: "node.created", label: "Node created" },
  { value: "node.updated", label: "Node updated" },
  { value: "node.deleted", label: "Node deleted" },
] as const;

export const OPERATOR_OPTIONS = [
  { value: "eq", label: "equals" },
  { value: "changed", label: "changed" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
] as const;

export const STEP_TYPE_OPTIONS = [
  { value: "agent", label: "Run agent" },
  { value: "tool", label: "Call tool" },
  { value: "condition", label: "Condition" },
  { value: "webhook", label: "Webhook" },
  { value: "prompt", label: "Prompt" },
  { value: "human_input", label: "Human input" },
] as const;

// ── Pure factory helpers ───────────────────────────────────────────────────────

export function emptyCondition(): PropertyCondition {
  return { property: "", operator: "eq", toValue: "" };
}

export function emptyStep(): AutomationStep {
  return { name: "", stepType: "agent", config: {} };
}
