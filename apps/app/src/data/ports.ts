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
import type {
  ApprovalQueue,
  ResolvedApprovalItem,
  ResolvedApprovals,
} from "./contracts/approvals";
import type {
  AuditBundle,
  AuditExport,
  AuditExportQuery,
  AuditPage,
  AuditPageQuery,
  AuditRetention,
} from "./contracts/audit";
import type {
  ContractRate,
  EvidenceRetention,
  GauBucket,
  InvoicePage,
  PlanCard,
  UsageCredits,
} from "./contracts/billing";
import type { AssistantThread } from "./contracts/conversations";
import type { MandateDetail, MandateList } from "./contracts/mandates";
import type { FirstFrame, OnboardingGate } from "./contracts/onboarding";
import type {
  ApiKey,
  CostCenterList,
  DataPlane,
  MemberList,
  ModelCredential,
  RoleCatalog,
  SsoSettings,
  WorkspaceFacts,
  WorkspaceList,
} from "./contracts/org";
import type {
  RunChain,
  RunCost,
  RunDetail,
  RunFrameBody,
  RunOutputs,
  RunTranscript,
  RunTurns,
  TranscriptKind,
  TranscriptZoom,
} from "./contracts/run";
import type { RunWork, RunOutcomesPolicy } from "./contracts/run-work";
import type { PullRequestFilter, RunPage } from "./contracts/runs";
import type { RuntimeAgents, RuntimeList } from "./contracts/runtimes";
import type {
  OrgChoice,
  NavCounts,
  NotificationFeed,
  ShellContext,
  ViewerPreferences,
  WorkspaceChoice,
} from "./contracts/shell";
import type { SkillInventory, SkillConfiguration } from "./contracts/skills";
import type {
  DayRange,
  FleetSpend,
  GatewayPolicy,
  PriceBook,
  SpendBudgets,
  SpendDrill,
  SpendDrillKind,
  SpendFindingEvidence,
  SpendFindings,
  SpendGroupKind,
  SpendReport,
  SpendWaste,
  UnpricedModels,
} from "./contracts/spend";
import type {
  ContextPr,
  ProposalPage,
  RecordDetail,
  MemoryPage,
  OxagenTree,
  RecordKind,
  RecordPage,
  SteeringFreshness,
  SteeringDeliveries,
  SteeringHub,
} from "./contracts/steering";
import type {
  ApprovalRuleSet,
  ConnectionList,
  ConnectionStatus,
  CredentialGrantPage,
  KillSwitchBoard,
  McpServerList,
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
     * organization layout renders in, the zone the Audit day filters are
     * resolved against, and whether Enter sends in the assistant composer;
     * callers: features/shell/source.ts, features/shell/viewer-clock.tsx and
     * features/audit/filters.ts.
     */
    preferences(ctx: OrgCtx): Promise<Read<ViewerPreferences>>;
    /**
     * get_nav_counts, what waits on a person in one workspace: the sidebar's
     * Fleet, Steering and Audit counts; callers:
     * features/shell/workspace-activity.tsx and features/shell/source.ts.
     */
    counts(ctx: WsCtx): Promise<Read<NavCounts>>;
    /**
     * list_notifications, the viewer's newest rows and the unread count the
     * bell's dot reads; callers: features/shell/workspace-activity.tsx and
     * features/shell/source.ts. A WsCtx reads the organization's rows and that
     * workspace's. An OrgCtx reads the organization's rows alone, which is the
     * whole feed for a viewer who can open no workspace (#3806).
     */
    notifications(ctx: OrgCtx): Promise<Read<NotificationFeed>>;
  };
  /**
   * get_conversation with no id: the viewer's latest active conversation in
   * the workspace, the thread the assistant flyout reopens (#4163), or null
   * when the viewer has none. Caller:
   * features/shell/assistant-thread-actions.ts, when the flyout opens in a
   * workspace it has not read yet.
   */
  conversations: {
    latest(ctx: WsCtx): Promise<Read<AssistantThread | null>>;
  };
  /**
   * The Billing page's six noBillingGate reads, each Owner, Admin or Billing
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
    /** get_evidence_retention: the included window, its price, and the volume held once it is measured */
    retention(ctx: OrgCtx): Promise<Read<EvidenceRetention>>;
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
   * the Frames tab has a frame open, caller features/run/run.tsx. `chain` is
   * `get_run_chain`, read only when the Chain and seal tab is open, because it
   * walks the recording to find its gaps.
   */
  runs: {
    list(
      ctx: WsCtx,
      q: {
        cursor: string | null;
        /** Runs per page, 1 to 100; absent reads the contract's ceiling. */
        limit?: number;
        /** Runs with or without pull requests; absent is every run. */
        pullRequests?: PullRequestFilter;
      },
    ): Promise<Read<RunPage>>;
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
    /**
     * `get_run_turns`, the run's per-turn ledger over every frame, read only
     * when the Cost tab is open; caller features/run/cost.tsx.
     */
    turns(ctx: WsCtx, runId: string): Promise<Read<RunTurns>>;
    /**
     * `get_run_transcript` at one zoom level, narrowed to the chips pressed
     * and paged on the cursor the last page carried. An empty `kinds` keeps
     * every frame: no chip pressed is not the same as every chip pressed off.
     * `limit` is the entries a page carries, the contract's default when
     * omitted.
     */
    transcript(
      ctx: WsCtx,
      runId: string,
      zoom: TranscriptZoom,
      q?: { kinds?: TranscriptKind[]; after?: string | null; limit?: number },
    ): Promise<Read<RunTranscript>>;
    chain(ctx: WsCtx, runId: string): Promise<Read<RunChain>>;
    /**
     * `get_run_outputs`, the spine: what the run produced, in the order it
     * produced it. Read with the page, not with a tab, because it is the page
     * — caller features/run/run.tsx.
     */
    outputs(ctx: WsCtx, runId: string): Promise<Read<RunOutputs>>;
    work(ctx: WsCtx, runId: string): Promise<Read<RunWork>>;
    outcomesSettings(ctx: WsCtx): Promise<Read<RunOutcomesPolicy>>;
  };
  /** list_approvals, the workspace's pending approvals or one run's; caller: features/fleet/fleet.tsx. */
  approvals: {
    /**
     * The whole pending queue, walked to the end of its cursor under a bound,
     * with `more` set when the bound stopped the walk. The Fleet waiting tile
     * counts it, so one page read as the whole queue was a figure that read as
     * a fact.
     */
    pending(
      ctx: WsCtx,
      q: { runId: string | null },
    ): Promise<Read<ApprovalQueue>>;
    /**
     * list_resolved_approvals, narrowed to one run: the Run page's Approvals
     * tab reads back a resolved decision, including one a decision rule
     * auto-approved with no person, that `pending` never shows (#3153).
     * Walked to the end of the run's ledger under a bound, with `more` set
     * when the bound stopped the walk (#3477).
     */
    resolved(
      ctx: WsCtx,
      q: { runId: string },
    ): Promise<Read<ResolvedApprovals>>;
    /**
     * list_resolved_approvals since an instant, one page: the approvals
     * drawer's "N resolved today" (mockup `apdBody()`), with `more` set when
     * the page did not reach the end; caller: features/shell/source.ts.
     */
    resolvedSince(
      ctx: WsCtx,
      q: { since: string },
    ): Promise<Read<{ items: ResolvedApprovalItem[]; more: boolean }>>;
  };
  /**
   * The Agents pages (#2956), each read by the agent's public id or slug:
   * list_agents, one cursor page of the workspace's identities, callers
   * features/agents/agents.tsx, features/tools/tools.tsx (the grant
   * dialog's agent picker) and features/fleet/fleet.tsx (the steer dialog's
   * agents and the Live runs tile's workspace total); get_agent, the identity with its credentials,
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
   * reads) and features/agents/mandates.tsx (the mandates one agent holds).
   * features/run/run.tsx and the shell's approvals drawer
   * (features/shell/source.ts) read it for the bar on their approval
   * cards; Fleet draws no approval card and reads none.
   */
  mandates: {
    list(ctx: WsCtx, q: { agentId: string | null }): Promise<Read<MandateList>>;
    /**
     * One mandate with its ledger (`get_mandate`): the mandate page. Caller:
     * features/mandate/mandate.tsx. `mandateId` is the public id the URL names,
     * and the read answers `not_found` for a mandate this workspace has not
     * recorded, which the page turns into a 404 rather than a page error.
     */
    get(ctx: WsCtx, mandateId: string): Promise<Read<MandateDetail>>;
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
    /**
     * get_tacho_session_policy: what the loopback gateway refuses for a
     * wrapped Claude Code or Codex session in this workspace. Read beside the
     * budgets because both are ceilings, and rendered apart because one is
     * Oxagen's own spend and the other is somebody's laptop.
     */
    gatewayPolicy(ctx: WsCtx): Promise<Read<GatewayPolicy>>;
    /** list_findings over the open findings (#2963): the Findings section's cards and the totals above them */
    findings(ctx: WsCtx): Promise<Read<SpendFindings>>;
    /** get_finding_evidence: the runs, calls and prices one finding cites */
    findingEvidence(
      ctx: WsCtx,
      findingId: string,
    ): Promise<Read<SpendFindingEvidence>>;
    /**
     * list_price_entries at the read instant: every provider list price and
     * this organization's negotiated rows, the book the Pricing tab shows.
     */
    priceBook(ctx: WsCtx): Promise<Read<PriceBook>>;
    /**
     * list_unpriced_models over its default window: the models the book
     * cannot price, which is why those runs come back with no cost.
     */
    unpricedModels(ctx: WsCtx): Promise<Read<UnpricedModels>>;
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
   * features/organization/people.tsx, roles.tsx, workspaces.tsx, api-keys.tsx,
   * features/audit/audit.tsx (actor names, off `members`) and
   * features/runtimes/runtime.tsx (operator names, off `members`). Three are
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
     * list_repositories and list_agents inside one workspace: its bound
     * repositories and its agent count, for the Workspaces row. A `WsCtx`,
     * because both reads are workspace-scoped; the tab makes one per workspace
     * the viewer may enter.
     */
    workspaceFacts(ctx: WsCtx): Promise<Read<WorkspaceFacts>>;
    /** list_cost_centers, the organization's live chargeback labels (ADR-142) */
    costCenters(ctx: OrgCtx): Promise<Read<CostCenterList>>;
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
    /** get_data_plane {kind:"postgres"}, redacted; the Data plane tab. */
    dataPlane(ctx: OrgCtx): Promise<Read<DataPlane>>;
    /**
     * list_sso_providers — the organisation's identity providers, their
     * domain proofs and group mappings, and whether SSO is required. No
     * secret: a stored one is reported as set. Org-scoped; callers:
     * features/organization/sso.tsx and roles.tsx.
     */
    sso(ctx: OrgCtx): Promise<Read<SsoSettings>>;
  };
  /**
   * The organization's audit record (#3097), both noBillingGate reads for an
   * org Owner or Admin (checked in the handlers); callers:
   * features/audit/audit.tsx and features/audit/export.ts. Both take a window
   * whose bounds are instants: the reader's calendar days are resolved in the
   * viewer's zone by the lane, since no port implementation has a viewer.
   */
  audit: {
    /** query_audit_log, one page at `offset`; the day filters arrive resolved (AuditWindow) */
    events(ctx: OrgCtx, q: AuditPageQuery): Promise<Read<AuditPage>>;
    /** export_audit_events: the signed file over the same window */
    exportEvents(ctx: OrgCtx, q: AuditExportQuery): Promise<Read<AuditExport>>;
    /**
     * get_evidence_retention (org Owner, Admin or Billing): the body retention
     * the header's mono line and the Retention tab print; caller
     * features/audit/audit.tsx.
     */
    retention(ctx: OrgCtx): Promise<Read<AuditRetention>>;
    /**
     * get_export_status for the organization export Build bundle queued, read
     * back by the id the Exports tab's URL carries; caller
     * features/audit/audit.tsx.
     */
    bundle(ctx: OrgCtx, exportId: string): Promise<Read<AuditBundle>>;
  };
  /**
   * list_skills, one page by name over its default window (noBillingGate;
   * workspace members, checked in its handler); caller:
   * features/skills/skills.tsx.
   */
  skills: {
    configuration(ctx: WsCtx): Promise<Read<SkillConfiguration>>;
    inventory(
      ctx: WsCtx,
      q: { cursor: string | null },
    ): Promise<Read<SkillInventory>>;
  };
  /**
   * The Steering page's reads on the workspace, each noBillingGate; callers:
   * features/steering/steering.tsx and features/record/record.tsx.
   */
  steering: {
    deliveries(ctx: WsCtx): Promise<Read<SteeringDeliveries>>;
    /** list_records, status active: one page of the records in force, of one kind or all */
    records(
      ctx: WsCtx,
      q: {
        kind: RecordKind | null;
        offset: number;
        /** Rows to a page, 1 to `STEERING_READ_MAX`; `STEERING_PAGE` when omitted. */
        limit?: number;
      },
    ): Promise<Read<RecordPage>>;
    /**
     * get_record on a lineage: the published record's page (#3395). Reads the
     * record back out of `.oxagen/rules/<lineage>.toml` on the production
     * branch, so it answers for a lineage the registry has no row for; 404
     * when neither the repository nor the registry holds it.
     */
    record(ctx: WsCtx, lineage: string): Promise<Read<RecordDetail>>;
    /**
     * list_proposals: one page, newest first. `lineage` narrows to the
     * proposals raised on one record, which is how the record page answers
     * whether a change is already open against it (#3395) rather than
     * guessing from the first page of everything.
     */
    proposals(
      ctx: WsCtx,
      q: { offset: number; lineage?: string },
    ): Promise<Read<ProposalPage>>;
    /** get_context_pr: one proposal's state machine, checks and what merge will do */
    contextPr(ctx: WsCtx, proposalId: string): Promise<Read<ContextPr>>;
    /** get_steering_freshness: what is published, where, and the two gates */
    freshness(ctx: WsCtx): Promise<Read<SteeringFreshness>>;
    /**
     * The hub header's reads: list_repositories and get_repository_tree for
     * the governance mode on the main repository, and three list_proposals
     * counts for the proposals waiting. Each half fails on its own inside the
     * value, so a GitHub outage never takes the library down with it.
     */
    hub(ctx: WsCtx): Promise<Read<SteeringHub>>;
    /**
     * list_memories: the workspace's active `:AgentMemory` nodes, newest
     * first, up to `limit` (1 to `STEERING_READ_MAX`); the Memory shelf and
     * its chip count.
     */
    memories(ctx: WsCtx, q: { limit: number }): Promise<Read<MemoryPage>>;
    /**
     * list_repositories and get_repository_tree: every path under `.oxagen/`
     * on the main repository's production branch, for the Records shelf's On
     * disk panel; `unbound` when no main repository is bound.
     */
    tree(ctx: WsCtx): Promise<Read<OxagenTree>>;
  };
  /**
   * The Tools page's six reads on the workspace (#2958), each role-checked in
   * its handler or in IAM (INV-29); caller: features/tools/tools.tsx.
   *
   * The first four are `noBillingGate`. `list_connections` and
   * `list_mcp_servers` are not, so an org out of credits is refused those two
   * as `exhausted`, which the seam answers with the page's error state.
   */
  tools: {
    /**
     * list_tool_versions: one cursor page of the registry, optionally one
     * consequence tag, one server (its `mcs_…` id), or both
     */
    versions(
      ctx: WsCtx,
      q: { category: string | null; cursor: string | null; serverId: string | null },
    ): Promise<Read<ToolVersionPage>>;
    /** list_credential_grants: one cursor page of the broker's grants, newest first */
    grants(
      ctx: WsCtx,
      q: { cursor: string | null },
    ): Promise<Read<CredentialGrantPage>>;
    /** list_kill_switches: the switches reaching this workspace, with the deny generation */
    killSwitches(ctx: WsCtx): Promise<Read<KillSwitchBoard>>;
    /** list_approval_rules: the workspace's auto-approval rules with their 30-day counters */
    approvalRules(ctx: WsCtx): Promise<Read<ApprovalRuleSet>>;
    /** list_connections: every data-source connection the filter admits; no cursor */
    connections(
      ctx: WsCtx,
      q: { status: ConnectionStatus | null; connectorId: string | null },
    ): Promise<Read<ConnectionList>>;
    /** list_mcp_servers: every registered MCP server in the workspace; no filter, no cursor */
    mcpServers(ctx: WsCtx): Promise<Read<McpServerList>>;
  };
  /**
   * The Runtimes page (roadmap mockups/pages/runtimes.md); caller:
   * features/runtimes/runtimes.tsx. `list` is `list_tacho_hosts` walked to the
   * end of its cursor under a bound: one row per host enrollment, which is one
   * agent on one machine, because no host row exists. `agents` is
   * `list_agents` walked until every named key is found, for the Agents on
   * this host table.
   */
  runtimes: {
    list(ctx: WsCtx): Promise<Read<RuntimeList>>;
    agents(ctx: WsCtx, keys: readonly string[]): Promise<Read<RuntimeAgents>>;
  };
}
