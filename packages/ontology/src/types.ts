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

// Spec §8.1 vector index registry. One entry per (label, property) pair;
// migrate.ts iterates this so adding a new embedding source is a one-line
// change.
export const VectorIndexes = [
  { label: "Document", property: "embedding", name: "document_embedding_index", dimensions: 1536, similarity: "cosine" },
  { label: "AgentMemory", property: "embedding", name: "memory_embedding_index", dimensions: 1536, similarity: "cosine" },
  { label: "Message", property: "embedding", name: "message_embedding_index", dimensions: 1536, similarity: "cosine" },
] as const;
