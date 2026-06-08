// Spec §8. Node labels and edge types are mirrored here so app code can
// reference them as constants rather than stringly-typed literals.

export const NodeLabels = {
  Tenant: "Tenant",
  Workspace: "Workspace",
  User: "User",
  Agent: "Agent",
  AgentVersion: "AgentVersion",
  Tool: "Tool",
  ToolVersion: "ToolVersion",
  Playbook: "Playbook",
  PlaybookVersion: "PlaybookVersion",
  Execution: "Execution",
  Document: "Document",
  AgentMemory: "AgentMemory",
  Conversation: "Conversation",
  Message: "Message",
  WorkflowRun: "WorkflowRun",
  // Agent runtime epic (spec §6).
  Skill: "Skill",
  SkillVersion: "SkillVersion",
  BackgroundTask: "BackgroundTask",
  Plan: "Plan",
} as const;
export type NodeLabel = (typeof NodeLabels)[keyof typeof NodeLabels];

export const EdgeTypes = {
  OWNS: "OWNS",
  MEMBER_OF: "MEMBER_OF",
  USES_TOOL: "USES_TOOL",
  EXECUTED: "EXECUTED",
  PRODUCED: "PRODUCED",
  DERIVED_FROM: "DERIVED_FROM",
  TRIGGERED_BY: "TRIGGERED_BY",
  TRIGGERED: "TRIGGERED",
  REFERENCES: "REFERENCES",
  REMEMBERS: "REMEMBERS",
  SIMILAR_TO: "SIMILAR_TO",
  REPLIES_TO: "REPLIES_TO",
  BRANCHED_FROM: "BRANCHED_FROM",
  CONTAINS: "CONTAINS",
  // Agent runtime epic (spec §6).
  INVOKED: "INVOKED",
  LOADED_SKILL: "LOADED_SKILL",
  BRANCHED_TO_SUBAGENT: "BRANCHED_TO_SUBAGENT",
  APPROVED_BY: "APPROVED_BY",
  ORIGINATED_FROM: "ORIGINATED_FROM",
  CALLED_TOOL: "CALLED_TOOL",
} as const;
export type EdgeType = (typeof EdgeTypes)[keyof typeof EdgeTypes];

// Vector index definitions are authoritative in src/schema.cypher.
// See the CREATE VECTOR INDEX statements there (spec §8.1).
