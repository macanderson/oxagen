// Typed Agents values for the Agents component tests (ARCHITECTURE.md §5):
// identity rows, one agent, a toolbelt, incidents, and a DataSource that
// answers the agents reads with what a test hands it. Importable from tests
// only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  AgentDetail,
  AgentPage,
  IncidentPage,
  RuntimeRef,
  Toolbelt,
  ToolbeltRef,
} from "@/data/contracts/agents";
import type { MandateList } from "@/data/contracts/mandates";
import type { RoleCatalog } from "@/data/contracts/org";
import type { RunPage, RunRow } from "@/data/contracts/runs";
import type { NamedRuntimeList } from "@/data/contracts/runtimes";
import type { ToolbeltList } from "@/data/contracts/toolbelts";
import type {
  SpendBudgets,
  SpendFindings,
  SpendReport,
} from "@/data/contracts/spend";
import type { SteeringDeliveries } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

type AgentRow = AgentPage["agents"][number];

/** The runtime the sample agent runs on (ADR-192). */
export const BUILD_BOX: RuntimeRef = {
  id: "rtm_buildbox",
  name: "Build box",
  slug: "build-box",
};

/** The workspace's All tools belt, which the sample agent carries. */
export const ALL_TOOLS: ToolbeltRef = {
  id: "tbt_alltools",
  name: "All tools",
  slug: "all-tools",
  kind: "all_tools",
};

export function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agt_releasebot",
    slug: "release-bot",
    name: "Release bot",
    description: "Cuts releases and opens their pull requests.",
    agentKey: "acme.core.release-bot",
    harness: "claude-code",
    runtime: BUILD_BOX,
    toolbelt: ALL_TOOLS,
    operatorId: "usr_marcusbell",
    operatorName: "Marcus Bell",
    principalId: "prn_91",
    credentials: 1,
    hosts: 1,
    host: "build-01",
    status: "enrolled",
    enforcementTier: "gateway",
    runs30d: 42,
    spend30d: { micros: "12500000", currency: "USD", basis: "client_attested" },
    tokens30d: { total: 1_840_000, cacheReadRate: 0.62, sessions: 40 },
    mandates: 0,
    incidents: 1,
    tamperIncidents: 0,
    tamperIncidentsRecorded: 0,
    ...overrides,
  };
}

export function agentPage(
  agents: AgentRow[],
  nextCursor: string | null = null,
  totals: Partial<AgentPage["totals"]> = {},
): Read<AgentPage> {
  return readOk({
    agents,
    nextCursor,
    totals: {
      identities: 7,
      retired: 0,
      enrolled: 2,
      unenrolled: 5,
      holdingMandate: 1,
      mandateHolders: ["acme.core.release-bot"],
      tamperIncidents: 3,
      tamper: {
        recorded: 4,
        open: 3,
        newest: {
          agentKey: "acme.core.release-bot",
          kind: "hooks_removed",
          detectedAt: "2026-09-11T09:16:04.000Z",
        },
      },
      ...totals,
    },
  });
}

type DetailOverrides = {
  identity?: Partial<AgentDetail["identity"]>;
} & Partial<Omit<AgentDetail, "identity">>;

export function agentDetail(overrides: DetailOverrides = {}): AgentDetail {
  const { identity, ...rest } = overrides;
  return {
    identity: {
      id: "agt_releasebot",
      slug: "release-bot",
      name: "Release bot",
      description: "Cuts releases and opens their pull requests.",
      agentKey: "acme.core.release-bot",
      harness: "claude-code",
      principalId: "prn_91",
      operatorId: "usr_marcusbell",
      status: "enrolled",
      registeredAt: "2026-09-01T10:00:00.000Z",
      firstFrameAt: "2026-09-02T10:00:00.000Z",
      costCenter: null,
      ...identity,
    },
    credentials: [
      {
        id: "aky_1",
        name: "release-bot run key",
        prefix: "oxa_ag_7f",
        createdAt: "2026-09-01T10:00:00.000Z",
        expiresAt: "2099-03-01T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    roles: [
      {
        id: "rol_ci",
        name: "CI writer",
        scopeKind: "workspace",
        assignedAt: "2026-09-02T10:00:00.000Z",
        expiresAt: null,
      },
    ],
    hosts: [
      {
        hostEnrollmentId: "tch_0123456789abcdefghijkl",
        hostname: "build-01",
        platform: "linux",
        status: "active",
        mode: "enforce",
        deviceKeyFingerprint: "sha256:ab12cd34",
        collectorVersion: null,
        hooksOk: null,
        bundleVersionServed: null,
        lastSeenAt: null,
        expiresAt: "2099-09-01T10:00:00.000Z",
        revokedAt: null,
      },
    ],
    runtime: BUILD_BOX,
    toolbelt: ALL_TOOLS,
    versions: [
      {
        version: 1,
        changeKind: "registered",
        runtime: BUILD_BOX,
        toolbelt: ALL_TOOLS,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ],
    limits: {
      perRun: null,
      perDay: null,
      containmentRequired: false,
      invalid: false,
    },
    ...rest,
  };
}

export function toolbelt(overrides: Partial<Toolbelt> = {}): Toolbelt {
  return {
    computedAt: "2026-09-15T09:00:00.000Z",
    computation: {
      humanCeiling: "caller",
      roleGrants: 4,
      denyGeneration: { org: 2, workspace: 0 },
      killSwitches: 1,
    },
    presentation: { mode: "full", limit: 40, sentToModel: "definitions" },
    tools: [
      {
        name: "github__create_pull_request",
        kind: "mcp",
        server: "mcp_github",
        category: "source control",
        riskLevel: "medium",
        decision: "require_approval",
        rule: "agent:7:role_grant",
        readOnly: false,
        // An MCP tool whose server was never imported into the registry: the
        // belt records no schema for it.
        inputSchema: null,
        schemaOrigin: null,
        schemaDigest: null,
        schemaTruncated: false,
      },
      {
        name: "search_tools",
        kind: "capability",
        server: null,
        category: null,
        riskLevel: "low",
        decision: "allow",
        rule: "human:8:default",
        readOnly: true,
        // A capability: its schema is derived from the contract.
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        schemaOrigin: "declared",
        schemaDigest:
          "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
        schemaTruncated: false,
      },
    ],
    cannotSee: [
      {
        name: "delete_repository",
        kind: "capability",
        server: null,
        rule: "agent:3:deny",
      },
    ],
    ...overrides,
  };
}

export function incidentPage(
  incidents: IncidentPage["incidents"],
  nextCursor: string | null = null,
): Read<IncidentPage> {
  return readOk({ incidents, nextCursor });
}

export function incident(
  overrides: Partial<IncidentPage["incidents"][number]> = {},
): IncidentPage["incidents"][number] {
  return {
    id: "tin_1",
    kind: "hooks_removed",
    severity: "tamper",
    detectedAt: "2026-09-14T10:00:00.000Z",
    detectedBy: "collector",
    sessionId: null,
    resolvedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

/** The ceilings an agent runs under, as the Budgets tab reads them (get_spend_budget). */
export function spendBudgets(
  overrides: Partial<SpendBudgets[number]> = {},
): SpendBudgets {
  return [
    {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      windowDays: null,
      limit: { micros: "500000000", currency: "USD" },
      spent: { micros: "125000000", currency: "USD" },
      ratio: 0.25,
      state: "ok",
      ...overrides,
    },
  ];
}

/** A run of the release bot on the newest page of runs (list_runs). */
export function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "arun_7k2m9q",
    source: "ledger",
    agentKey: "acme.core.release-bot",
    operatorId: "usr_marcusbell",
    operatorKind: "human",
    operatorName: "Marcus Bell",
    status: "sealed",
    outcome: "completed",
    turns: 34,
    steps: 271,
    frames: 1204,
    cost: { micros: "4131265", currency: "USD", basis: "gateway_observed" },
    model: null,
    machine: null,
    taskRef: null,
    name: "Cut the 3.2 release branch",
    summary: null,
    replayGrade: "fork",
    verdict: null,
    enforcementTier: "harness",
    completenessGaps: [],
    canSummarize: false,
    startedAt: "2026-09-15T08:00:00.000Z",
    sealedAt: "2026-09-15T08:40:00.000Z",
    ...overrides,
  };
}

export function runPage(runs: RunRow[]): Read<RunPage> {
  return readOk({ runs, nextCursor: null });
}

type SpendRow = SpendReport["rows"][number];

/** The release bot's row of get_spend at the agent level. */
export function spendRow(overrides: Partial<SpendRow> = {}): SpendRow {
  return {
    key: "acme.core.release-bot",
    provider: null,
    operator: null,
    cost: { micros: "12500000", currency: "USD", basis: "gateway_observed" },
    calls: 100,
    runs: 4,
    proven: null,
    accepted: null,
    productiveRatio: 0.5,
    tokens: {
      input_uncached: 1000,
      cache_read: 3000,
      cache_write_5m: 500,
      cache_write_1h: 500,
      output: 800,
      reasoning: 200,
    },
    ...overrides,
  };
}

export function spendReport(rows: SpendRow[]): Read<SpendReport> {
  const figure = rows[0] ?? spendRow();
  return readOk({
    period: { from: "2026-08-18", to: "2026-09-16" },
    total: {
      cost: figure.cost,
      calls: figure.calls,
      runs: figure.runs,
      proven: null,
      accepted: null,
      productiveRatio: null,
    },
    rows,
  });
}

type Delivery = SteeringDeliveries["runs"][number];

/** get_steering_deliveries with the manifests handed in. */
export function steeringDeliveries(
  runs: Partial<Delivery>[] = [{}],
): Read<SteeringDeliveries> {
  return readOk({
    runs: runs.map((run) => ({
      sessionUuid: "0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b",
      ts: "2026-09-15T08:00:00.000Z",
      harness: "claude-code",
      agentKey: "acme.core.release-bot",
      recordsIncluded: 6,
      recordsCut: 3,
      recordsCutForBudget: 2,
      budgetTokens: 4000,
      spentTokens: 2600,
      ...run,
    })),
    undelivered: [],
    scanned: runs.length,
    truncated: false,
  });
}

type Finding = SpendFindings["findings"][number];

export function spendFindings(
  findings: Partial<Finding>[],
): Read<SpendFindings> {
  return readOk({
    window: null,
    saving: null,
    spend: null,
    share: null,
    annualised: null,
    counts: {
      findings: findings.length,
      high: findings.length,
      medium: 0,
      operators: 0,
    },
    findings: findings.map((finding) => ({
      id: "fnd_01",
      kind: "duplicate_tool_calls",
      level: "agent",
      subject: "acme.core.release-bot",
      saving: { micros: "2000000", currency: "USD", basis: "gateway_observed" },
      confidence: "high",
      window: {
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-15T00:00:00.000Z",
      },
      why: "The same read ran twice on eleven turns.",
      fix: "Cache the first result.",
      runs: 3,
      calls: 22,
      ...finding,
    })),
  });
}

/** The organization's role catalogue with the release bot's CI writer role in it. */
export function roleCatalog(): Read<RoleCatalog> {
  return readOk({
    roles: [
      {
        id: "rol_ci",
        name: "CI writer",
        description: null,
        scope: "workspace",
        kind: "agent",
        builtIn: false,
        permissions: ["repo.write", "pr.open"],
        heldBy: 1,
        createdBy: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    catalog: [],
    enforcement: { tier: "enterprise", enforced: true },
  });
}

type AgentReads = {
  list?: Read<AgentPage>;
  get?: Read<AgentDetail>;
  toolbelt?: Read<Toolbelt>;
  incidents?: Read<IncidentPage>;
  mandates?: Read<MandateList>;
  /** The Budgets tab's read; it is `spend.budgets`, not an agents port method. */
  budgets?: Read<SpendBudgets>;
  /** The newest page of runs, which the header's tier and replay badges read. */
  runs?: Read<RunPage>;
  /** get_spend at the agent level over the trailing 30 days. */
  spend?: Read<SpendReport>;
  deliveries?: Read<SteeringDeliveries>;
  findings?: Read<SpendFindings>;
  roles?: Read<RoleCatalog>;
  /** `list_toolbelts`, which the Toolbelt tab's belt picker reads; `beltList()` when absent. */
  belts?: Read<ToolbeltList>;
  /** `list_runtimes`, which the Runtime tab's Move control reads; `runtimeList()` when absent. */
  runtimes?: Read<NamedRuntimeList>;
};

/** The workspace's belts: the All tools belt the sample agent carries and one clone. */
export function beltList(): Read<ToolbeltList> {
  const all = {
    ...ALL_TOOLS,
    description: null,
    clonedFrom: null,
    tools: 12,
    activeTools: 12,
    servers: 2,
    agents: 1,
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
  return readOk({
    belts: [
      all,
      {
        ...all,
        id: "tbt_reviewbelt",
        name: "Review belt",
        slug: "review-belt",
        kind: "custom",
        clonedFrom: ALL_TOOLS,
        tools: 4,
        activeTools: 3,
        servers: 1,
        agents: 0,
      },
    ],
    availableTools: 12,
  });
}

/** The build box the sample agent runs on, and a laptop that already runs Claude Code. */
export function runtimeList(): Read<NamedRuntimeList> {
  return readOk({
    runtimes: [
      {
        ...BUILD_BOX,
        createdAt: "2026-09-01T10:00:00.000Z",
        agents: [
          {
            id: "agt_releasebot",
            name: "Release bot",
            slug: "release-bot",
            harness: "claude-code",
          },
        ],
        liveHosts: 1,
        lastSeenAt: null,
      },
      {
        id: "rtm_macslaptop",
        name: "Mac's laptop",
        slug: "macs-laptop",
        createdAt: "2026-09-20T10:00:00.000Z",
        agents: [
          {
            id: "agt_macclaude",
            name: "Mac Claude",
            slug: "mac-claude",
            harness: "claude-code",
          },
        ],
        liveHosts: 1,
        lastSeenAt: null,
      },
      {
        id: "rtm_gpubox",
        name: "GPU box",
        slug: "gpu-box",
        createdAt: "2026-09-21T10:00:00.000Z",
        agents: [],
        liveHosts: 0,
        lastSeenAt: null,
      },
    ],
  });
}

/** A DataSource answering the agents reads it was handed; `calls` records each read's arguments. */
export function agentsSource(reads: AgentReads) {
  const calls: Record<keyof AgentReads, unknown[][]> = {
    list: [],
    get: [],
    toolbelt: [],
    incidents: [],
    mandates: [],
    budgets: [],
    runs: [],
    spend: [],
    deliveries: [],
    findings: [],
    roles: [],
    belts: [],
    runtimes: [],
  };
  const refuse = () => Promise.reject(new Error("not an Agents read"));
  const answer =
    <T>(read: Read<T> | undefined, name: keyof AgentReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`agents.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = {
    runtimes: {
      list: refuse,
      agents: refuse,
      named: answer(reads.runtimes ?? runtimeList(), "runtimes"),
    },
    conversations: { latest: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: answer(reads.runs, "runs"),
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      outputs: refuse,
      work: refuse,
      outcomesSettings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    agents: {
      list: answer(reads.list, "list"),
      get: answer(reads.get, "get"),
      toolbelt: answer(reads.toolbelt, "toolbelt"),
      incidents: answer(reads.incidents, "incidents"),
    },
    mandates: { list: answer(reads.mandates, "mandates"), get: refuse },
    spend: {
      byGroup: answer(reads.spend, "spend"),
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: answer(reads.budgets, "budgets"),
      findings: answer(reads.findings, "findings"),
      findingEvidence: refuse,
      priceBook: refuse,
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: answer(reads.roles, "roles"),
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: answer(reads.deliveries, "deliveries"),
      memories: refuse,
      tree: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
      toolbelts: answer(reads.belts ?? beltList(), "belts"),
      toolbelt: refuse,
    },
  };
  return { source, calls };
}
