// types.ts: the collector/v1 file and the triage/v1 decision.
//
// agent-work-spec.html (Shared contract) is the source. Each JSON Schema in
// schemas/ describes the same shape as a type here, and src/schemas.test.ts
// validates the spec's examples against both. Keys keep the snake_case the
// files use, so a parsed file is the typed value with no mapping.
import type { WorkItemId } from "@oxagen/done-record";

// ---------------------------------------------------------------------------
// collector/v1: work/collectors/<name>.toml
// ---------------------------------------------------------------------------

/** The value of `schema` in a collector file. */
export const COLLECTOR_SCHEMA = "collector/v1" as const;

/**
 * The collector types. Each is one module at packages/ingestion/src/collectors/<type>.ts.
 * WORK_COLLECTOR_TYPES in @oxagen/database and CollectorType in @oxagen/ingestion
 * repeat this list. Change all three together.
 */
export const COLLECTOR_TYPES = [
  "github",
  "jira",
  "linear",
  "zendesk",
  "servicenow",
  "salesforce",
  "slack",
  "email",
] as const;
export type CollectorType = (typeof COLLECTOR_TYPES)[number];

/** The collector types with no write-back. Email also has no connection. */
export const COLLECTOR_TYPES_WITHOUT_WRITE_BACK = ["slack", "email"] as const;

/** A collector type that names a connection and may write back. */
export type ProviderCollectorType = Exclude<CollectorType, (typeof COLLECTOR_TYPES_WITHOUT_WRITE_BACK)[number]>;

/** Where a collector stands. */
export const COLLECTOR_HEALTH = ["healthy", "lagging", "failing", "paused"] as const;
export type CollectorHealth = (typeof COLLECTOR_HEALTH)[number];

/** The minutes between reconciles, so a missed event costs at most this long. */
export const RECONCILE_INTERVAL_MINUTES = 15;

/** One or more owner/name repositories. */
export interface GithubScope {
  repos: string[];
}

/** A Jira Cloud site, its project keys, and an optional JQL filter. */
export interface JiraScope {
  site: string;
  projects: string[];
  jql?: string;
}

/** Linear team keys. */
export interface LinearScope {
  teams: string[];
}

/** A Zendesk subdomain, and views or groups. */
export type ZendeskScope = { subdomain: string } & (
  | { views: string[]; groups?: string[] }
  | { views?: string[]; groups: string[] }
);

/** A ServiceNow instance, its table, and an optional encoded query. */
export interface ServicenowScope {
  instance: string;
  /** Defaults to `incident`. */
  table?: string;
  query?: string;
}

/** A Salesforce My Domain, and record types or queues. */
export type SalesforceScope = { my_domain: string } & (
  | { record_types: string[]; queues?: string[] }
  | { record_types?: string[]; queues: string[] }
);

/** How a Slack collector picks messages. */
export const SLACK_TRIGGERS = ["reaction", "every_message"] as const;
export type SlackTrigger = (typeof SLACK_TRIGGERS)[number];

/** A Slack channel id, how messages are picked, and the bots it reads. */
export interface SlackScope {
  channel: string;
  /** Defaults to `reaction`. */
  trigger?: SlackTrigger;
  allow_bots?: string[];
}

/** Senders whose mail becomes a work item, and the addresses that forward it. */
export interface EmailScope {
  /** An address, or `@domain` for a whole domain. */
  allow: string[];
  forwarders?: string[];
}

/** The [scope] table of each collector type. */
export interface CollectorScopes {
  github: GithubScope;
  jira: JiraScope;
  linear: LinearScope;
  zendesk: ZendeskScope;
  servicenow: ServicenowScope;
  salesforce: SalesforceScope;
  slack: SlackScope;
  email: EmailScope;
}

/** What Oxagen writes back to the provider (tasks-spec.md §5.4, plus labels). */
export interface WriteBackSwitches {
  certify_note?: boolean;
  send_note?: boolean;
  status?: boolean;
  close?: boolean;
  labels?: boolean;
}

/** The switches a collector file leaves out. */
export const WRITE_BACK_DEFAULTS: Readonly<Required<WriteBackSwitches>> = {
  certify_note: true,
  send_note: true,
  status: false,
  close: false,
  labels: false,
};

/** What every work item from a collector starts with. */
export interface CollectorDefaults {
  labels?: string[];
  /** A workflow slug in work/workflows/. */
  workflow?: string;
}

interface CollectorFileBase<T extends CollectorType> {
  schema: typeof COLLECTOR_SCHEMA;
  /** Matches the file name. */
  name: string;
  label: string;
  type: T;
  scope: CollectorScopes[T];
  defaults?: CollectorDefaults;
}

/** A collector file that names a connection and may write back. */
export type ProviderCollectorFile = {
  [T in ProviderCollectorType]: CollectorFileBase<T> & {
    connection: string;
    write_back?: WriteBackSwitches;
  };
}[ProviderCollectorType];

/** A Slack collector file. It names a connection and never writes back. */
export type SlackCollectorFile = CollectorFileBase<"slack"> & { connection: string };

/** An email collector file. Oxagen assigns the address, so there is no connection. */
export type EmailCollectorFile = CollectorFileBase<"email">;

/** A collector/v1 file. It names a connection and never holds a credential. */
export type CollectorFile = ProviderCollectorFile | SlackCollectorFile | EmailCollectorFile;

// ---------------------------------------------------------------------------
// triage/v1: work.triage_decisions.output
// ---------------------------------------------------------------------------

/** The value of `schema` in a triage decision. */
export const TRIAGE_SCHEMA = "triage/v1" as const;

/** What triage decided about the item. */
export const TRIAGE_STATES = ["triaged", "needs_info", "duplicate", "out_of_scope"] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

/**
 * The Priority labels (tasks-spec.md §6.4). WORK_PRIORITY_LABELS in
 * @oxagen/database repeats this list for the check constraints on
 * work.items. Change both together.
 */
export const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

/** The most triage decisions one workspace runs a minute. The rest queue. */
export const TRIAGE_DECISIONS_PER_MINUTE = 60;

/** One triage decision on one work item. */
export interface TriageDecision {
  schema: typeof TRIAGE_SCHEMA;
  item: WorkItemId;
  state: TriageState;
  priority: {
    label: PriorityLabel;
    reason: string;
    /** Rules of the priorities record, as `<lineage>#<number>`. */
    cites: string[];
  };
  labels: string[];
  /** Estimated agent minutes. */
  estimate_minutes: number;
  /** Path globs the agent predicts the work will change. */
  claims: string[];
  duplicates: WorkItemId[];
  related: WorkItemId[];
  /** A workflow slug, or null when no workflow applies. Phase 1 runs no workflows, so triage writes null. */
  workflow: string | null;
  /** The drafted acceptance criteria. Null only when the state is not `triaged`. */
  done_record: { criteria: string[] } | null;
  /** Questions for the people in the workspace. Never for the requester. */
  questions: string[];
  conflicts: string[];
}
