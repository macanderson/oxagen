// Typed Agents values for the Agents component tests (ARCHITECTURE.md §5):
// identity rows, one agent, a toolbelt, incidents, and a DataSource that
// answers the agents reads with what a test hands it. Importable from tests
// only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  AgentDetail,
  AgentPage,
  IncidentPage,
  Toolbelt,
} from "@/data/contracts/agents";
import type { MandateList } from "@/data/contracts/mandates";
import type { SpendBudgets } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

type AgentRow = AgentPage["agents"][number];

export function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agt_releasebot",
    slug: "release-bot",
    name: "Release bot",
    description: "Cuts releases and opens their pull requests.",
    agentKey: "acme.core.release-bot",
    harness: "claude-code",
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
      enrolled: 2,
      holdingMandate: 1,
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
    definition: null,
    ...rest,
  };
}

export const DEFINITION_SOURCE = `schema = "agent-definition/v0.1"
slug = "release-bot"
name = "Release bot"
model_tier = "complex"
tools = ["github__*", "linear__get_issue"]
side_effects = ["read", "write"]
budget = { per_run_micros = 2500000 }

[instructions]
body = """
You prepare releases.
"""

[harness.claude-code]
color = "blue"
`;

export function committedDefinition(
  source = DEFINITION_SOURCE,
): NonNullable<AgentDetail["definition"]> {
  return {
    path: ".oxagen/agents/release-bot.toml",
    digest: "a".repeat(64),
    commitSha: "9c1e2f0",
    branch: "agents/release-bot",
    pullRequestUrl: "https://github.com/acme/core/pull/12",
    source,
    committedAt: "2026-09-03T10:00:00.000Z",
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

type AgentReads = {
  list?: Read<AgentPage>;
  get?: Read<AgentDetail>;
  toolbelt?: Read<Toolbelt>;
  incidents?: Read<IncidentPage>;
  mandates?: Read<MandateList>;
  /** The Budgets tab's read; it is `spend.budgets`, not an agents port method. */
  budgets?: Read<SpendBudgets>;
};

/** A DataSource answering the agents reads it was handed; `calls` records each read's arguments. */
export function agentsSource(reads: AgentReads) {
  const calls: Record<keyof AgentReads, unknown[][]> = {
    list: [],
    get: [],
    toolbelt: [],
    incidents: [],
    mandates: [],
    budgets: [],
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
    runtimes: { list: refuse, agents: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse, preferences: refuse },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      transcript: refuse,
      chain: refuse,
      outputs: refuse,
    },
    approvals: { pending: refuse, resolved: refuse },
    agents: {
      list: answer(reads.list, "list"),
      get: answer(reads.get, "get"),
      toolbelt: answer(reads.toolbelt, "toolbelt"),
      incidents: answer(reads.incidents, "incidents"),
    },
    mandates: { list: answer(reads.mandates, "mandates"), get: refuse },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: answer(reads.budgets, "budgets"),
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      sso: refuse,
    },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      deliveries: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
    },
  };
  return { source, calls };
}
