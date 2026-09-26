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
  // No code writes the message-based :Fanout projection, so it has no label
  // here and its BRANCHED_TO_SUBAGENT and ORIGINATED_FROM edges have no edge
  // types. schema.cypher still declares the :Fanout constraint and index.
  // Ingestion pipeline — fixed system nodes (not customer ontology types).
  // SourceConnection: one node per registered data source connection.
  SourceConnection: "SourceConnection",
  // EntityNode: universal primary label on ALL customer ontology nodes.
  // Every ingested entity carries this label plus `entityType` (string property)
  // and optionally a secondary TitleCase label for simple type names.
  // Workspace-scoped. Queried as: MATCH (n:EntityNode {workspaceId: $wid, entityType: $type})
  EntityNode: "EntityNode",
  // Fleet lineage graph projection: an idempotent MERGE projection of
  // agent.subagent_fanouts / agent.subagent_runs rows — the authoritative
  // Postgres chain-of-custody — into first-class graph nodes so the dispatch
  // tree is queryable as graph data. These labels are keyed on the
  // subagent_fanouts/subagent_runs row ids.
  SubagentFanout: "SubagentFanout",
  SubagentRun: "SubagentRun",
  // Context-window lineage (ADR-193): one node per model request a run
  // recorded a window for, projected best-effort from the run's model-call
  // frames by packages/agent/src/dispatch/context-projection.ts. It carries
  // which blocks the window held and how many items each had, never bytes or
  // tokens: the frame is the record, and no read depends on this node.
  ContextManifest: "ContextManifest",
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
  APPROVED_BY: "APPROVED_BY",
  CALLED_TOOL: "CALLED_TOOL",
  // Two-axis memory lifecycle. schema.cypher documented both edge types from
  // the start; the registry only caught up on 2026-09-15.
  PROMOTED: "PROMOTED", // Promotion → AgentMemory (auditable class promotion)
  DEMOTED: "DEMOTED", // Demotion → AgentMemory (auditable class demotion)
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
  // Fleet lineage graph projection. See NodeLabels.SubagentFanout.
  DISPATCHED: "DISPATCHED", // SubagentFanout → SubagentRun (direct child)
  SPAWNED_FANOUT: "SPAWNED_FANOUT", // SubagentRun → SubagentFanout (nested dispatch; recursion spine)
  // Context-window lineage (ADR-193). A best-effort projection of the
  // windows on a run's model-call frames; get_run_context reads the frames.
  USED_CONTEXT: "USED_CONTEXT", // Execution → ContextManifest (one per measured window)
} as const;
export type EdgeType = (typeof EdgeTypes)[keyof typeof EdgeTypes];

// Vector index definitions are authoritative in src/schema.cypher.
// See the CREATE VECTOR INDEX statements there (spec §8.1).
