// The shape of the fixture seed: every collection typed by its view-model
// contract. seed.ts parses the mapped mockup data through this at load, so a
// mapping that produces a value the contracts reject fails loudly, once.
import { z } from "zod";
import {
  AccountView,
  AgentDefinition,
  AgentDetail,
  AgentScores,
  ApiKey,
  ApprovalItem,
  ArchiveExport,
  AssuranceHistoryRow,
  AssistantEngine,
  AssuranceRun,
  AuditEvent,
  AutoApprovalRule,
  BillingPlan,
  Budget,
  Connection,
  ContextWindow,
  Count,
  DataPlane,
  DetectedRepository,
  EmbeddingIndex,
  EncryptionKey,
  ErasureRequest,
  Finding,
  FindingEvidence,
  FindingFix,
  FirstFrameScript,
  Frame,
  Incident,
  InstallerOffer,
  Instant,
  Invitation,
  InvitationView,
  Invoice,
  KillSwitch,
  LegalHold,
  Mandate,
  MandateLedgerEntry,
  Member,
  Meter,
  ModelFunding,
  Namespace,
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
  RunGraph,
  RunProof,
  Source,
  SpendByAgent,
  SpendByModel,
  SpendByOperator,
  SpendByTool,
  SpendDrill,
  SpendSummary,
  SteeringProposal,
  SteeringRecord,
  Toolbelt,
  ToolServer,
  ToolVersion,
  TranscriptEntry,
  WasteReport,
  Workspace,
} from "@/data/contracts";

const byRun = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

export const Seed = z.object({
  /** The instant the demo record is read at. Relative times in the mockup resolve against it. */
  now: Instant,
  organization: Organization,
  workspaces: z.array(Workspace),
  people: z.array(Person),
  members: z.array(Member),
  invitations: z.array(Invitation),
  apiKeys: z.array(ApiKey),
  dataPlanes: z.array(DataPlane),
  modelFunding: ModelFunding,
  roles: z.array(Role),
  permissionGroups: z.array(PermissionGroup),

  agents: z.array(AgentDetail),
  toolbelts: z.array(Toolbelt),
  definitions: z.array(AgentDefinition),
  scores: z.array(AgentScores),

  runs: z.array(RunDetail),
  /** W4: frames are keyed by run, never one list shared by every run. */
  frames: byRun(z.array(Frame)),
  transcripts: byRun(z.array(TranscriptEntry)),
  runGraphs: byRun(RunGraph),
  contextWindows: byRun(ContextWindow),
  proofs: byRun(RunProof),

  approvals: z.array(ApprovalItem),
  /** How long each approval had waited when the mockup drew it; the adapter re-bases clocks on it. */
  approvalClocks: z.record(
    z.string(),
    z.object({ waitedSeconds: Count, timeoutSeconds: Count }),
  ),
  /** W4: mandates are keyed by id; the Mandate page never renders MANDATES[0]. */
  mandates: z.array(Mandate),
  mandateLedger: z.array(MandateLedgerEntry),

  servers: z.array(ToolServer),
  toolVersions: z.array(ToolVersion),
  connections: z.array(Connection),
  observedSchemas: z.array(ObservedSchemaProposal),
  killSwitches: z.array(KillSwitch),
  autoApprovalRules: z.array(AutoApprovalRule),
  assurance: AssuranceRun,
  policyVersions: z.array(PolicyVersion),
  policySimulations: z.array(PolicySimulation),

  classes: z.array(OntologyClass),
  sources: z.array(Source),
  repositories: z.array(Repository),
  ontologyVersions: z.array(OntologyVersion),
  embeddingIndexes: z.array(EmbeddingIndex),

  records: z.array(SteeringRecord),
  proposals: z.array(SteeringProposal),
  recordEffects: z.array(RecordEffect),
  retirementCandidates: z.array(RetirementCandidate),

  spend: z.object({
    summary: SpendSummary,
    byOperator: z.array(SpendByOperator),
    byAgent: z.array(SpendByAgent),
    byModel: z.array(SpendByModel),
    byTool: z.array(SpendByTool),
    waste: WasteReport,
    drills: z.array(SpendDrill),
    findings: z.array(Finding),
    evidence: z.array(FindingEvidence),
    fixes: z.array(FindingFix),
    reconciliation: ReconciliationSummary,
    budgets: z.array(Budget),
  }),

  billing: z.object({
    plan: BillingPlan,
    allowance: RunAllowance,
    meters: z.array(Meter),
    invoices: z.array(Invoice),
  }),

  audit: z.object({
    events: z.array(AuditEvent),
    incidents: z.array(Incident),
    receipts: z.array(Receipt),
    holds: z.array(LegalHold),
    exports: z.array(ArchiveExport),
    keys: z.array(EncryptionKey),
    erasure: z.array(ErasureRequest),
    retention: z.array(RetentionTier),
    assuranceHistory: z.array(AssuranceHistoryRow),
  }),

  notifications: z.array(Notification),

  /** Register an agent and the onboarding gate (spec §4.4). */
  onboarding: z.object({
    /** Read off the seeded agent keys (`org_ns.ws_ns.slug`); keyed by workspace slug. */
    namespaces: z.object({
      org: Namespace,
      workspaces: z.record(z.string(), Namespace),
    }),
    installer: InstallerOffer,
    /** Frame bodies carry `{harness}`, `{agentKey}` and `{operator}` for the agent being wrapped. */
    firstFrame: FirstFrameScript,
    repository: DetectedRepository,
    /** One invitation per state /invite/[token] renders, keyed by public token. */
    invitations: z.array(InvitationView),
  }),

  shell: z.object({
    engine: z.object({
      up: AssistantEngine,
      down: AssistantEngine,
    }),
    /** The fixture operator's Account dialog; the identity is the session's. */
    account: AccountView,
  }),
});
export type Seed = z.infer<typeof Seed>;
