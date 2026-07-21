// Spec §8. Node labels and edge types are mirrored here so app code can
// reference them as constants rather than stringly-typed literals.
//
// IMPORTANT: NodeLabels contains only FIXED SYSTEM nodes — nodes whose
// existence is guaranteed by the platform regardless of customer configuration.
// Customer ontology entity types are free-form strings (e.g. "task", "contact")
// carried as the `entityType` property on :EntityNode nodes and observed durably
// in ClickHouse (internal.graph_observed_labels). They must NOT be added here.

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
  // Subagent fanout (docs/specs/graph-mediated-fanout-phase2 §2): the origin
  // node terminal fanout children hang off via [:ORIGINATED_FROM], so "what
  // did this fanout produce?" is one traversal.
  Fanout: "Fanout",
  // Ingestion pipeline — fixed system nodes (not customer ontology types).
  // SourceConnection: one node per registered data source connection.
  SourceConnection: "SourceConnection",
  // EntityNode: universal primary label on ALL customer ontology nodes.
  // Every ingested entity carries this label plus `entityType` (string property)
  // and optionally a secondary TitleCase label for simple type names.
  // Workspace-scoped. Queried as: MATCH (n:EntityNode {workspaceId: $wid, entityType: $type})
  EntityNode: "EntityNode",
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
  // Ingestion pipeline — provenance + deduplication edges.
  ALIAS_OF: "ALIAS_OF", // alias node → principal (dedup; carries confidence score)
  SOURCED_FROM: "SOURCED_FROM", // ingested EntityNode → SourceConnection
  INFERRED_FROM: "INFERRED_FROM", // inferred edge → source entities that triggered inference
  // Agent execution provenance — event-triggered executions.
  INITIATED_FROM: "INITIATED_FROM", // Execution → triggering EntityNode
  DOCUMENTED_BY: "DOCUMENTED_BY", // EntityNode → Document written by the agent about it
  CREATED_BY: "CREATED_BY", // Document → Execution that produced it
  // Semantic / structural edges written by connectors and inference workers.
  IMPLEMENTS: "IMPLEMENTS", // commit/PR EntityNode → feature EntityNode
  PART_OF: "PART_OF", // issue → epic; commit → PR
  ASSIGNED_TO: "ASSIGNED_TO", // task/issue → User
  AUTHORED_BY: "AUTHORED_BY", // document/commit → User
} as const;
export type EdgeType = (typeof EdgeTypes)[keyof typeof EdgeTypes];

// Vector index definitions are authoritative in src/schema.cypher.
// See the CREATE VECTOR INDEX statements there (spec §8.1).
