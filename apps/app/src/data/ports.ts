// Read ports, one per domain (plan §4.5). Pages read only through
// `dataSource()`, which returns a `DataSource`; every method takes the viewer's
// scope and returns a `Read<T>`, so "not recorded yet", an error and a denial
// are values a page renders, never exceptions or zeros.
//
// src/data/backing.ts records, per method, which page reads it, which Batch 3
// lane wires it, and the milestone and gap it waits on.
import type {
  AgentDefinition,
  AgentDetail,
  AgentRow,
  AgentScores,
  ApiKey,
  ApprovalItem,
  ArchiveExport,
  AssistantEngineHealth,
  AssuranceHistoryRow,
  AssuranceRun,
  AuditEvent,
  AutoApprovalRule,
  BillingPlan,
  Budget,
  Connection,
  ContextWindow,
  DataPlane,
  DrillKind,
  EmbeddingIndex,
  EncryptionKey,
  ErasureRequest,
  Finding,
  FindingEvidence,
  FindingFix,
  Frame,
  Incident,
  Invitation,
  Invoice,
  KillSwitch,
  LegalHold,
  MandateDetail,
  Mandate,
  Member,
  Meter,
  ModelFunding,
  Notification,
  ObservedSchemaProposal,
  OntologyClass,
  OntologyVersion,
  Organization,
  PermissionGroup,
  Person,
  PolicySimulation,
  PolicyVersion,
  Receipt,
  ReconciliationSummary,
  RecordEffect,
  Repository,
  RetentionTier,
  RetirementCandidate,
  Role,
  RunAllowance,
  RunDetail,
  RunFilter,
  RunGraph,
  RunPage,
  RunProof,
  SteeringProposal,
  SteeringRecord,
  Source,
  SpendByAgent,
  SpendByModel,
  SpendByOperator,
  SpendByTool,
  SpendDrill,
  SpendSummary,
  Toolbelt,
  ToolServer,
  ToolVersion,
  TranscriptEntry,
  WasteReport,
  Workspace,
} from "./contracts";
import type { Read } from "./not-backed";
import type { Scope } from "./scope";

type R<T> = Promise<Read<T>>;

export interface RunReadPort {
  listRuns(scope: Scope, q: { filter: RunFilter; cursor?: string }): R<RunPage>;
  getRun(scope: Scope, runId: string): R<RunDetail>;
  /** Frames after `afterSeq` (exclusive), oldest first. `"-1"` reads from the start. */
  framesSince(
    scope: Scope,
    runId: string,
    afterSeq: string,
    limit?: number,
  ): R<Frame[]>;
  transcript(scope: Scope, runId: string): R<TranscriptEntry[]>;
  runGraph(scope: Scope, runId: string): R<RunGraph>;
  /** Null when the run recorded no context assembly. */
  contextWindow(scope: Scope, runId: string): R<ContextWindow | null>;
  /** Null when no witness ran for this run. */
  proof(scope: Scope, runId: string): R<RunProof | null>;
}

export interface ApprovalReadPort {
  /** Pending (and recently expired) approvals, for the workspace or one run. */
  pending(scope: Scope, q?: { runId?: string }): R<ApprovalItem[]>;
}

export interface AgentReadPort {
  listAgents(scope: Scope): R<AgentRow[]>;
  getAgent(scope: Scope, agentKey: string): R<AgentDetail>;
  toolbelt(scope: Scope, agentKey: string): R<Toolbelt>;
  definition(scope: Scope, agentKey: string): R<AgentDefinition>;
  scores(scope: Scope, agentKey: string): R<AgentScores>;
  incidents(scope: Scope, agentKey: string): R<Incident[]>;
  mandates(scope: Scope, agentKey: string): R<Mandate[]>;
  getMandate(scope: Scope, mandateId: string): R<MandateDetail>;
}

export interface IamReadPort {
  roles(scope: Scope): R<Role[]>;
  permissionCatalog(scope: Scope): R<PermissionGroup[]>;
}

export interface ToolReadPort {
  servers(scope: Scope): R<ToolServer[]>;
  toolVersions(scope: Scope, q?: { serverId?: string }): R<ToolVersion[]>;
  connections(scope: Scope): R<Connection[]>;
  observedSchemas(scope: Scope): R<ObservedSchemaProposal[]>;
  mandateLedger(scope: Scope): R<MandateDetail[]>;
  policyVersions(scope: Scope): R<PolicyVersion[]>;
  /** Null when the version was never simulated. */
  policySimulation(
    scope: Scope,
    policyVersionId: string,
  ): R<PolicySimulation | null>;
  killSwitches(scope: Scope): R<KillSwitch[]>;
  autoApprovalRules(scope: Scope): R<AutoApprovalRule[]>;
  /** Null before the suite first runs. */
  assurance(scope: Scope): R<AssuranceRun | null>;
}

export interface OntologyReadPort {
  classes(scope: Scope): R<OntologyClass[]>;
  sources(scope: Scope): R<Source[]>;
  repositories(scope: Scope): R<Repository[]>;
  versions(scope: Scope): R<OntologyVersion[]>;
  embeddingIndexes(scope: Scope): R<EmbeddingIndex[]>;
}

export interface SteeringReadPort {
  records(scope: Scope): R<SteeringRecord[]>;
  proposals(scope: Scope): R<SteeringProposal[]>;
  effect(scope: Scope): R<RecordEffect[]>;
  retirementCandidates(scope: Scope): R<RetirementCandidate[]>;
}

export interface SpendReadPort {
  summary(scope: Scope): R<SpendSummary>;
  byOperator(scope: Scope): R<SpendByOperator[]>;
  byAgent(scope: Scope): R<SpendByAgent[]>;
  byModel(scope: Scope): R<SpendByModel[]>;
  byTool(scope: Scope): R<SpendByTool[]>;
  waste(scope: Scope): R<WasteReport>;
  drill(scope: Scope, kind: DrillKind, id: string): R<SpendDrill>;
  findings(scope: Scope): R<Finding[]>;
  findingEvidence(scope: Scope, findingId: string): R<FindingEvidence>;
  findingFix(scope: Scope, findingId: string): R<FindingFix>;
  reconciliation(scope: Scope): R<ReconciliationSummary>;
  budgets(scope: Scope): R<Budget[]>;
}

export interface OrgReadPort {
  organization(scope: Scope): R<Organization>;
  members(scope: Scope): R<Member[]>;
  invitations(scope: Scope): R<Invitation[]>;
  workspaces(scope: Scope): R<Workspace[]>;
  apiKeys(scope: Scope): R<ApiKey[]>;
  dataPlanes(scope: Scope): R<DataPlane[]>;
  modelFunding(scope: Scope): R<ModelFunding>;
}

export interface BillingReadPort {
  plan(scope: Scope): R<BillingPlan>;
  allowance(scope: Scope): R<RunAllowance>;
  meters(scope: Scope): R<Meter[]>;
  invoices(scope: Scope): R<Invoice[]>;
}

export interface AuditReadPort {
  events(scope: Scope): R<AuditEvent[]>;
  incidents(scope: Scope): R<Incident[]>;
  receipts(scope: Scope): R<Receipt[]>;
  getReceipt(scope: Scope, receiptId: string): R<Receipt>;
  holds(scope: Scope): R<LegalHold[]>;
  exports(scope: Scope): R<ArchiveExport[]>;
  keys(scope: Scope): R<EncryptionKey[]>;
  erasure(scope: Scope): R<ErasureRequest[]>;
  retention(scope: Scope): R<RetentionTier[]>;
  assuranceHistory(scope: Scope): R<AssuranceHistoryRow[]>;
}

export interface ShellReadPort {
  notifications(scope: Scope): R<Notification[]>;
  people(scope: Scope): R<Person[]>;
  assistantEngine(scope: Scope): R<AssistantEngineHealth>;
}

/** One field per port. The only object a page gets from `dataSource()`. */
export interface DataSource {
  runs: RunReadPort;
  approvals: ApprovalReadPort;
  agents: AgentReadPort;
  iam: IamReadPort;
  tools: ToolReadPort;
  ontology: OntologyReadPort;
  steering: SteeringReadPort;
  spend: SpendReadPort;
  org: OrgReadPort;
  billing: BillingReadPort;
  audit: AuditReadPort;
  shell: ShellReadPort;
}

export type PortName = keyof DataSource;
export type MethodName<P extends PortName> = Extract<
  keyof DataSource[P],
  string
>;
