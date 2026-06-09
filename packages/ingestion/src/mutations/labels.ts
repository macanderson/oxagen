/**
 * Neo4j node labels and edge types introduced by the ingestion pipeline.
 * Must stay in sync with packages/ontology/src/types.ts.
 */

export const IngestionNodeLabels = {
  SourceConnection: "SourceConnection",
  // Ingested entities — each connector adds to these
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
} as const;

export const IngestionEdgeTypes = {
  ALIAS_OF: "ALIAS_OF",
  SOURCED_FROM: "SOURCED_FROM",
  INFERRED_FROM: "INFERRED_FROM",
  IMPLEMENTS: "IMPLEMENTS",
  REFERENCES: "REFERENCES",
  RELATED_TO: "RELATED_TO",
  OWNED_BY: "OWNED_BY",
  ASSIGNED_TO: "ASSIGNED_TO",
  PART_OF: "PART_OF",
} as const;
