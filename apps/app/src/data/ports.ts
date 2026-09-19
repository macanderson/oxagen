// The typed list of reads a page may make (ARCHITECTURE.md §3.3). Every method
// takes the viewer's ctx and returns a `Read<T>`, and every method has a
// production caller (INV-17). The rev1 ports land with the seams and pages
// that bind them: the Fleet ports in WL-34, the Run and Organization ports in
// WL-35 to WL-37, the Billing port in WL-38, the Spend port in #2962; each gap
// lane adds its page's port (#2956: agents; #2961: steering; #3097: audit;
// #3098: skills).
import type { OrgCtx, PretenantCtx, WsCtx } from "@/server/viewer";
import type {
  AgentDetail,
  AgentPage,
  IncidentPage,
  Toolbelt,
} from "./contracts/agents";
import type { ApprovalItem } from "./contracts/approvals";
import type {
  AuditExport,
  AuditExportFormat,
  AuditFilters,
  AuditPage,
  AuditQuery,
} from "./contracts/audit";
import type {
  ContractRate,
  GauBucket,
  InvoicePage,
  PlanCard,
  UsageCredits,
} from "./contracts/billing";
import type { MandateList } from "./contracts/mandates";
import type { FirstFrame, OnboardingGate } from "./contracts/onboarding";
import type {
  ApiKey,
  MemberList,
  ModelCredential,
  RoleCatalog,
  WorkspaceList,
} from "./contracts/org";
import type {
  RunCost,
  RunDetail,
  RunFrameBody,
  RunTranscript,
  TranscriptZoom,
} from "./contracts/run";
import type { RunPage } from "./contracts/runs";
import type {
  OrgChoice,
  ShellContext,
  ViewerPreferences,
  WorkspaceChoice,
} from "./contracts/shell";
import type { SkillInventory } from "./contracts/skills";
import type {
  DayRange,
  FleetSpend,
  SpendBudgets,
  SpendDrill,
  SpendDrillKind,
  SpendFindingEvidence,
  SpendFindings,
  SpendGroupKind,
  SpendReport,
  SpendWaste,
} from "./contracts/spend";
import type {
  ContextPr,
  ProposalPage,
  RecordKind,
  RecordPage,
} from "./contracts/steering";
import type {
  CredentialGrantPage,
  KillSwitchBoard,
  ToolVersionPage,
} from "./contracts/tools";
import type { Read } from "./read";

export interface DataSource {
  /**
   * list_orgs and list_workspaces ({orgSlug}) for a signed-in person before
   * any organization context; callers: features/shell/landing.ts and
   * features/auth/cli-consent.ts. The only
   * port that takes a PretenantCtx, so src/data/live/pretenant.ts is the only
   * caller of kernelRead's PretenantCtx overload.
   */
  pretenant: {
    orgs(ctx: PretenantCtx): Promise<Read<OrgChoice[]>>;
    workspaces(
      ctx: PretenantCtx,
      orgSlug: string,
    ): Promise<Read<WorkspaceChoice[]>>;
  };
  shell: {
    /** list_orgs + list_workspaces; caller: features/shell/source.ts. */
    context(ctx: OrgCtx): Promise<Read<ShellContext>>;
    /**
     * get_user_preferences, user-global: the zone every date under the
     * organization layout renders in; callers: features/shell/source.ts and
     * features/shell/viewer-clock.tsx. request_mandate reads the same
     * preference through kernelRead (ADR-089) rather than this port, because
     * Architecture §2 refuses a feature edge into data/live.
     */
    preferences(ctx: OrgCtx): Promise<Read<ViewerPreferences>>;
  };
  /**
   * The Billing page's five noBillingGate reads, each Owner, Admin or Billing
   * (checked in its handler); caller: features/billing/billing.tsx.
   */
  billing: {
    /** get_subscription */
    plan(ctx: OrgCtx): Promise<Read<PlanCard>>;
    /**
     * get_subscription again, for the second meter's balance (§3.9). The two
     * reads are separate because a `Read<T>` carries one view model, and the
     * plan card is deliberately blind to the credit balance (INV-25).
     */
    usageCredits(ctx: OrgCtx): Promise<Read<UsageCredits>>;
    /** get_gau_bucket: mode, meter, invoice thresholds, auto top-up state */
    bucket(ctx: OrgCtx): Promise<Read<GauBucket>>;
    /** get_contract_rate */
    contractRate(ctx: OrgCtx): Promise<Read<ContractRate>>;
    /** list_invoices, one cursor page, newest first */
    invoices(
      ctx: OrgCtx,
      q: { cursor: string | null },
    ): Promise<Read<InvoicePage>>;
  };
  /**
   * The Fleet runs table and the Run page (WL-35). `list` is one cursor page of
   * `list_runs`, caller features/fleet/fleet.tsx. `get` is `get_run`: the same
   * row with one page of frames, caller features/run/run.tsx; `framesAfter` is
   * the opaque resume point the last page carried. `cost` is `get_run_cost`,
   * and `transcript` is `get_run_transcript` at one zoom level, each read by
   * its own tab, so a tab nobody opened makes no read. `frameBody` is
   * `get_run_frame_body`, one frame's bytes on demand (§3.5), read only when
   * the Frames tab has a frame open, caller features/run/run.tsx.
   */
  runs: {
    list(ctx: WsCtx, q: { cursor: string | null }): Promise<Read<RunPage>>;
    get(
      ctx: WsCtx,
      runId: string,
      q: { framesAfter: string | null },
    ): Promise<Read<RunDetail>>;
    frameBody(
      ctx: WsCtx,
      runId: string,
      seq: string,
    ): Promise<Read<RunFrameBody>>;
    cost(ctx: WsCtx, runId: string): Promise<Read<RunCost>>;
    transcript(
      ctx: WsCtx,
      runId: string,
      zoom: TranscriptZoom,
    ): Promise<Read<RunTranscript>>;
  };
  /** list_approvals, the workspace's pending approvals or one run's; caller: features/fleet/fleet.tsx. */
  approvals: {
    pending(
      ctx: WsCtx,
      q: { runId: string | null },
    ): Promise<Read<ApprovalItem[]>>;
  };
  /**
   * The Agents pages (#2956), each read by the agent's public id or slug:
   * list_agents, one cursor page of the workspace's identities, caller
   * features/agents/agents.tsx; get_agent, the identity with its credentials,
   * roles, hosts and cached definition, callers features/agents/agent.tsx and
   * agent-source.tsx; get_agent_toolbelt, the computed belt, and
   * list_incidents narrowed to the agent, one cursor page, caller
   * features/agents/agent.tsx.
   */
  agents: {
    list(ctx: WsCtx, q: { cursor: string | null }): Promise<Read<AgentPage>>;
    get(ctx: WsCtx, agent: string): Promise<Read<AgentDetail>>;
    toolbelt(ctx: WsCtx, agent: string): Promise<Read<Toolbelt>>;
    incidents(
      ctx: WsCtx,
      agent: string,
      q: { cursor: string | null },
    ): Promise<Read<IncidentPage>>;
  };
  /**
   * The mandates of the workspace, or of one agent (#2957): `list_mandates`,
   * each row carrying the remaining authority its ledger records. Callers:
   * features/tools/mandates-ledger.tsx (the ledger the accountable office
   * reads), features/agents/mandates.tsx (the mandates one agent holds) and
   * features/fleet/fleet.tsx (the bar on an approval card that names one).
   */
  mandates: {
    list(ctx: WsCtx, q: { agentId: string | null }): Promise<Read<MandateList>>;
  };
  /**
   * The cost rollup (#2962), every read noBillingGate; callers:
   * features/spend/spend.tsx and features/spend/fleet-tiles.tsx. `byGroup`
   * answers the period total with the groups, so the page's summary strip
   * reads the same call as its table.
   */
  spend: {
    /** get_spend */
    byGroup(
      ctx: WsCtx,
      groupBy: SpendGroupKind,
      period: DayRange,
    ): Promise<Read<SpendReport>>;
    /** get_spend at the model level over one day: Fleet's Spend today and Cache hit rate tiles */
    fleet(ctx: WsCtx, period: DayRange): Promise<Read<FleetSpend>>;
    /** get_spend_drill over its default trailing window */
    drill(
      ctx: WsCtx,
      kind: SpendDrillKind,
      key: string,
    ): Promise<Read<SpendDrill>>;
    /** list_waste */
    waste(ctx: WsCtx, period: DayRange): Promise<Read<SpendWaste>>;
    /** get_spend_budget */
    budgets(ctx: WsCtx): Promise<Read<SpendBudgets>>;
    /** list_findings over the open findings (#2963): the Findings section's cards and the totals above them */
    findings(ctx: WsCtx): Promise<Read<SpendFindings>>;
    /** get_finding_evidence: the runs, calls and prices one finding cites */
    findingEvidence(
      ctx: WsCtx,
      findingId: string,
    ): Promise<Read<SpendFindingEvidence>>;
  };
  /**
   * The onboarding gate and the register flow (#2967, ADR-065).
   * `get_onboarding_state` (`scoped: false`) answers where the organization
   * stands, read by features/onboarding/gate.tsx on Fleet and by the register
   * stepper; `get_first_frame` long-polls one registered agent's first frame,
   * caller features/onboarding/register.tsx.
   */
  onboarding: {
    /** get_onboarding_state */
    state(ctx: OrgCtx): Promise<Read<OnboardingGate>>;
    /** get_first_frame, waiting up to `waitMs` inside the one invoke (§3.5) */
    firstFrame(
      ctx: WsCtx,
      agent: string,
      q: { waitMs: number },
    ): Promise<Read<FirstFrame>>;
  };
  /**
   * The Organization pages' four reads, each noBillingGate (#2964, WL-37,
   * WL-43), each an Owner-or-Admin read checked in its handler; callers:
   * features/organization/people.tsx, roles.tsx, workspaces.tsx, api-keys.tsx
   * and features/audit/audit.tsx (actor names, off `members`). Three are
   * org-scoped; `apiKeys` is not, because a key names a workspace (ADR-073).
   */
  org: {
    /** list_members {scope:"org"} */
    members(ctx: OrgCtx): Promise<Read<MemberList>>;
    /** list_iam_roles, the roles and the permission catalogue */
    roles(ctx: OrgCtx): Promise<Read<RoleCatalog>>;
    /** list_workspaces, archived rows included */
    workspaces(ctx: OrgCtx): Promise<Read<WorkspaceList>>;
    /**
     * list_api_keys, every key of the workspace in scope, newest first,
     * revoked ones included. A `WsCtx`, never an `OrgCtx`: `auth.api_keys` is
     * policy class `standard`, so under the org-only sentinel the list matches
     * no key that exists and a mint writes one into a workspace that does not
     * (ADR-073). The page picks a workspace off `workspaces` and resolves into
     * it before it reads a key.
     */
    apiKeys(ctx: WsCtx): Promise<Read<ApiKey[]>>;
    /**
     * get_model_credential — the organisation's own model key, redacted.
     * Org-scoped: the key pays for every workspace's assistant turns.
     */
    modelCredential(ctx: OrgCtx): Promise<Read<ModelCredential>>;
  };
  /**
   * The organization's audit record (#3097), both noBillingGate reads for an
   * org Owner or Admin (checked in the handlers); callers:
   * features/audit/audit.tsx and features/audit/export.ts.
   */
  audit: {
    /** query_audit_log, one page at `offset` */
    events(ctx: OrgCtx, q: AuditQuery): Promise<Read<AuditPage>>;
    /** export_audit_events: the signed file over the same filters */
    exportEvents(
      ctx: OrgCtx,
      q: AuditFilters & { format: AuditExportFormat },
    ): Promise<Read<AuditExport>>;
  };
  /**
   * list_skills, one page by name over its default window (noBillingGate;
   * workspace members, checked in its handler); caller:
   * features/skills/skills.tsx.
   */
  skills: {
    inventory(
      ctx: WsCtx,
      q: { cursor: string | null },
    ): Promise<Read<SkillInventory>>;
  };
  /**
   * The Steering page's three noBillingGate reads on the workspace; caller:
   * features/steering/steering.tsx.
   */
  steering: {
    /** list_records, status active: one page of the records in force, of one kind or all */
    records(
      ctx: WsCtx,
      q: { kind: RecordKind | null; offset: number },
    ): Promise<Read<RecordPage>>;
    /** list_proposals: one page, newest first */
    proposals(ctx: WsCtx, q: { offset: number }): Promise<Read<ProposalPage>>;
    /** get_context_pr: one proposal's state machine, checks and what merge will do */
    contextPr(ctx: WsCtx, proposalId: string): Promise<Read<ContextPr>>;
  };
  /**
   * The Tools page's three noBillingGate reads on the workspace (#2958), each
   * role-checked in its handler (INV-29); caller: features/tools/tools.tsx.
   */
  tools: {
    /** list_tool_versions: one cursor page of the registry, optionally one consequence tag */
    versions(
      ctx: WsCtx,
      q: { category: string | null; cursor: string | null },
    ): Promise<Read<ToolVersionPage>>;
    /** list_credential_grants: one cursor page of the broker's grants, newest first */
    grants(
      ctx: WsCtx,
      q: { cursor: string | null },
    ): Promise<Read<CredentialGrantPage>>;
    /** list_kill_switches: the switches reaching this workspace, with the deny generation */
    killSwitches(ctx: WsCtx): Promise<Read<KillSwitchBoard>>;
  };
}
