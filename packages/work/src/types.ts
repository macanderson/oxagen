// types.ts: the files packages/work reads, the decisions and examples it
// writes, and the names every lane shares for them.
//
// agent-work-spec.html (Shared contract) is the source. Each JSON Schema in
// schemas/ describes the same shape as a type here, and src/schemas.test.ts
// validates the spec's examples against both. Keys keep the snake_case the
// files use, so a parsed file is the typed value with no mapping.
import type { CriterionTag, WorkItemId } from "@oxagen/done-record";
import type { Sha256Digest } from "@oxagen/run-evidence";

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
// work/v1: work/work.toml
// ---------------------------------------------------------------------------

/** The value of `schema` in work/work.toml. */
export const WORK_FILE_SCHEMA = "work/v1" as const;

/** The autonomy levels. Level 0 is the default for every scope. */
export const AUTONOMY_LEVELS = [0, 1, 2, 3] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The name people see for each level. */
export const AUTONOMY_LEVEL_NAMES: Readonly<Record<AutonomyLevel, string>> = {
  0: "Suggest",
  1: "Send",
  2: "Merge proven",
  3: "Autonomous",
};

/** The share of merged work items the operator reviews at level 3 when a scope sets none. */
export const DEFAULT_SAMPLE_RATE = 0.1;

/** A label, or a code repository with optional path globs. */
export type AutonomyScope = { label: string } | { repo: string; paths?: string[] };

/** One [[autonomy]] entry. */
export interface AutonomyEntry {
  scope: AutonomyScope;
  level: AutonomyLevel;
  /** The operator Oxagen acts as in this scope. */
  operator: string;
  max_daily_usd?: number;
  sample_rate?: number;
}

/** A work/v1 file. */
export interface WorkFile {
  schema: typeof WORK_FILE_SCHEMA;
  triage: {
    /** The operator the triage agent runs as. */
    operator: string;
    /** The lineage of the priorities steering record. */
    priorities: string;
    /** Model routes in order. Triage uses the first one no build stage pins. */
    models: string[];
  };
  autonomy?: AutonomyEntry[];
}

/** The Cedar actions each autonomy level allows or denies. */
export const WORK_ACTIONS = ["work.send", "work.merge", "work.lock", "work.close"] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];

/** What changed a scope's autonomy level. */
export const AUTONOMY_CAUSES = ["steering_pr", "revert", "escaped_defect", "sample_rejected"] as const;
export type AutonomyCause = (typeof AUTONOMY_CAUSES)[number];

/** A pull request's risk. Level 2 and level 3 never merge high-risk work. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** A change over this many lines, or over MEDIUM_RISK_FILES files, is medium risk. */
export const MEDIUM_RISK_LINES = 400;
export const MEDIUM_RISK_FILES = 20;

// ---------------------------------------------------------------------------
// The [training] table of workspace.toml
// ---------------------------------------------------------------------------

/** Whether a workspace trains a model of its own. Off is the default. */
export const TRAINING_CONSENTS = ["own_model", "off"] as const;
export type TrainingConsentValue = (typeof TRAINING_CONSENTS)[number];

/** The [training] table of workspace.toml. An org owner approves it by steering PR. */
export interface TrainingConsent {
  consent: TrainingConsentValue;
  /** The org owner who approved it. */
  approved_by?: string;
  /** The open-weight base model. */
  base?: string;
}

// ---------------------------------------------------------------------------
// oxagen-workflow/v0.3: work/workflows/<slug>.toml
// ---------------------------------------------------------------------------

/** The workflow schema this package writes. */
export const WORKFLOW_SCHEMA = "oxagen-workflow/v0.3" as const;

/** Every workflow schema v0.3 reads. v0.1 and v0.2 files read unchanged. */
export const WORKFLOW_SCHEMAS = ["oxagen-workflow/v0.1", "oxagen-workflow/v0.2", WORKFLOW_SCHEMA] as const;
export type WorkflowSchema = (typeof WORKFLOW_SCHEMAS)[number];

/** A stage's kind. A stage without one reads as build. */
export const STAGE_KINDS = ["build", "test", "verify", "review"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** What a failed stage does. Defaults to stop. */
export const ON_FAIL = ["stop", "return"] as const;
export type OnFail = (typeof ON_FAIL)[number];

/** The most times a stage may return work. */
export const MAX_RETURNS = 3;

/** Who accepts the work. proven needs the scope at level 2 or higher. */
export const ACCEPT_BY = ["operator", "proven"] as const;
export type AcceptBy = (typeof ACCEPT_BY)[number];

/** One [[stage]]. */
export interface WorkflowStage {
  role: string;
  /** v0.3 only. */
  kind?: StageKind;
  /** The agent's lineage. */
  agent: string;
  /** A model route that pins the stage's model. v0.3 only. */
  model?: string;
  owns?: CriterionTag[];
  /** Roles that hand off before this stage runs. v0.2 and later. */
  needs?: string[];
  on_fail?: OnFail;
  /** A 1-based stage index in v0.1, a role in v0.2 and later. */
  return_to?: number | string;
  max_returns?: number;
}

/** An oxagen-workflow file of any version v0.3 reads. */
export interface Workflow {
  schema: WorkflowSchema;
  name: string;
  /** v0.3 only, and required there. */
  owner?: string;
  /** v0.3 only. */
  match?: { labels?: string[]; collectors?: string[] };
  /** v0.3 only. */
  done?: { criteria: string[] };
  stage: WorkflowStage[];
  accept?: { by: AcceptBy };
}

// ---------------------------------------------------------------------------
// triage/v1: work.triage_decisions.output
// ---------------------------------------------------------------------------

/** The value of `schema` in a triage decision. */
export const TRIAGE_SCHEMA = "triage/v1" as const;

/** What triage decided about the item. */
export const TRIAGE_STATES = ["triaged", "needs_info", "duplicate", "out_of_scope"] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

/** The Priority labels. */
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
  /** A workflow slug, or null when none fits. */
  workflow: string | null;
  /** The drafted criteria, or null when triage drafts none. */
  done_record: { criteria: string[] } | null;
  /** Questions for the people in the workspace. Never for the requester. */
  questions: string[];
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// training-example/v1: one line of a training export
// ---------------------------------------------------------------------------

/** The value of `schema` in a training example. */
export const TRAINING_EXAMPLE_SCHEMA = "training-example/v1" as const;

/** How an example is labeled. unlabeled examples stay out of the first model. */
export const TRAINING_LABELS = ["positive", "negative", "unlabeled"] as const;
export type TrainingLabel = (typeof TRAINING_LABELS)[number];

/** A JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One chat message in the shape open-weight trainers read. */
export interface TrainingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: JsonObject[];
  tool_call_id?: string;
}

/** A triage correction a person made to the work item. */
export interface TrainingCorrection {
  field: string;
  before: JsonValue;
  after: JsonValue;
}

/** One done record with a final verdict, and the session that built against it. */
export interface TrainingExample {
  schema: typeof TRAINING_EXAMPLE_SCHEMA;
  item: WorkItemId;
  /** The done record's lock digest. */
  record: Sha256Digest;
  label: TrainingLabel;
  stage: StageKind;
  messages: TrainingMessage[];
  /** The tool definitions the session received. */
  tools: JsonObject[];
  diff: string;
  corrections: TrainingCorrection[];
}

// ---------------------------------------------------------------------------
// Names every lane shares
// ---------------------------------------------------------------------------

/** The checks Oxagen steering runs on a steering PR. */
export const TRIAGE_PREVIEW_CHECK = "Triage preview" as const;
export const AUTONOMY_EVIDENCE_CHECK = "Autonomy evidence" as const;
export const WORK_STEERING_CHECKS = [TRIAGE_PREVIEW_CHECK, AUTONOMY_EVIDENCE_CHECK] as const;

/** The MCP tools an agent calls on work. */
export const WORK_MCP_TOOLS = [
  "claim_dod_item",
  "hand_off_work_order",
  "return_work_order",
  "accept_work_order",
  "send_plan",
  "set_task_priority",
] as const;
export type WorkMcpTool = (typeof WORK_MCP_TOOLS)[number];

/** The OTLP span attributes Oxagen adds to the GenAI semantic conventions. */
export const WORK_OTLP_ATTRIBUTES = {
  workItemId: "oxagen.work_item.id",
  workOrderId: "oxagen.work_order.id",
  stageKind: "oxagen.stage.kind",
  doneRecordDigest: "oxagen.done_record.digest",
} as const;
