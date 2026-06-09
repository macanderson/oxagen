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
  // Ingestion pipeline — external data sources live 100% in Neo4j.
  SourceConnection: "SourceConnection",
  GitCommit: "GitCommit",
  PullRequest: "PullRequest",
  GithubIssue: "GithubIssue",
  LinearIssue: "LinearIssue",
  DriveFile: "DriveFile",
  SlackMessage: "SlackMessage",
  SlackChannel: "SlackChannel",
  ConfluencePage: "ConfluencePage",
  NotionPage: "NotionPage",
  JiraIssue: "JiraIssue",
  CalendarEvent: "CalendarEvent",
  EmailThread: "EmailThread",
  SalesforceContact: "SalesforceContact",
  SalesforceOpportunity: "SalesforceOpportunity",
  StripeCustomer: "StripeCustomer",
  StripeSubscription: "StripeSubscription",
  CustomSqlRow: "CustomSqlRow",
  OtelSpan: "OtelSpan",
  OtelMetric: "OtelMetric",
  // Inferred semantic nodes created by the Stage 5 LLM inference worker.
  Feature: "Feature",
  Topic: "Topic",
  Risk: "Risk",
  Decision: "Decision",
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
  ALIAS_OF: "ALIAS_OF",       // alias node → principal (dedup; carries confidence score)
  SOURCED_FROM: "SOURCED_FROM", // ingested node → SourceConnection
  INFERRED_FROM: "INFERRED_FROM", // inferred edge → source entities that triggered inference
  // Agent execution provenance — event-triggered executions.
  INITIATED_FROM: "INITIATED_FROM", // Execution → triggering graph node (e.g. new Feature node)
  DOCUMENTED_BY: "DOCUMENTED_BY",   // Feature → Document (user doc written by the agent)
  CREATED_BY: "CREATED_BY",         // Document → Execution that produced it
  // Semantic / structural edges written by connectors and inference workers.
  IMPLEMENTS: "IMPLEMENTS",   // Commit/PR → Feature
  PART_OF: "PART_OF",         // Issue → Epic; Commit → PR
  ASSIGNED_TO: "ASSIGNED_TO", // Issue/Task → User
  AUTHORED_BY: "AUTHORED_BY", // Document/Commit → User
} as const;
export type EdgeType = (typeof EdgeTypes)[keyof typeof EdgeTypes];

// Vector index definitions are authoritative in src/schema.cypher.
// See the CREATE VECTOR INDEX statements there (spec §8.1).
