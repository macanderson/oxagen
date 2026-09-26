// Fixtures and a DataSource for the Tools tests: the view models the page
// renders, each built from the contract-parsed record through the same mapper
// the live port uses, so a fixture cannot drift from the contract.
import {
  toApprovalRuleSet,
  toConnectionList,
  toCredentialGrantPage,
  toKillSwitchBoard,
  toMcpServerList,
  toToolVersionPage,
} from "@/data/live/mappers/tools";
import {
  toToolbeltDetail,
  toToolbeltList,
} from "@/data/live/mappers/toolbelts";
import type { DataSource } from "@/data/ports";
import type { toolbeltGet as toolbeltGetContract } from "@oxagen/oxagen/contracts/toolbelt.get";
import type { toolbeltList as toolbeltListContract } from "@oxagen/oxagen/contracts/toolbelt.list";
import {
  type ToolbeltDetail,
  ToolbeltDetail as ToolbeltDetailShape,
  type ToolbeltList,
  ToolbeltList as ToolbeltListShape,
} from "@/data/contracts/toolbelts";
import type { ContractOutput } from "@/server/kernel";
import type {
  ApprovalRuleSet,
  ConnectionList,
  CredentialGrantPage,
  KillSwitchBoard,
  McpServerList,
  ToolVersionPage,
} from "@/data/contracts/tools";
import {
  ApprovalRuleSet as ApprovalRuleSetShape,
  ConnectionList as ConnectionListShape,
  CredentialGrantPage as CredentialGrantPageShape,
  KILL_SWITCH_BOARD_LIMIT,
  KillSwitchBoard as KillSwitchBoardShape,
  McpServerList as McpServerListShape,
  ToolVersionPage as ToolVersionPageShape,
} from "@/data/contracts/tools";
import type { AgentPage, AgentStatus } from "@/data/contracts/agents";
import type { MandateList } from "@/data/contracts/mandates";
import type { MemberList } from "@/data/contracts/org";
import { type Read, readOk } from "@/data/read";
import { mandateList } from "@/test/mandate-views";
import {
  approvalRuleListOutput,
  connectionListOutput,
  credentialGrantListOutput,
  killSwitchListOutput,
  mcpServerListOutput,
  toolVersionListOutput,
} from "@/test/tools-outputs";

export function toolVersionPage(
  over: Parameters<typeof toolVersionListOutput>[0] = {},
): ToolVersionPage {
  return ToolVersionPageShape.parse(
    toToolVersionPage(toolVersionListOutput(over)),
  );
}

export function credentialGrantPage(
  over: Parameters<typeof credentialGrantListOutput>[0] = {},
): CredentialGrantPage {
  return CredentialGrantPageShape.parse(
    toCredentialGrantPage(credentialGrantListOutput(over)),
  );
}

export function killSwitchBoard(
  over: Parameters<typeof killSwitchListOutput>[0] = {},
  /** The limit the read asked for; pass the fixture's own length for a truncated board. */
  limit: number = KILL_SWITCH_BOARD_LIMIT,
): KillSwitchBoard {
  return KillSwitchBoardShape.parse(
    toKillSwitchBoard(killSwitchListOutput(over), limit),
  );
}

/** One agent as `list_agents` pages it, for the grant dialog's picker. */
export function agentPageRow(
  slug: string,
  status: AgentStatus = "enrolled",
): AgentPage["agents"][number] {
  return {
    id: `agt_${slug.replace(/[^0-9a-z]/g, "")}`,
    slug,
    name: slug,
    description: null,
    agentKey: null,
    harness: "custom",
    runtime: null,
    toolbelt: null,
    operatorId: null,
    operatorName: null,
    principalId: null,
    credentials: 0,
    hosts: 0,
    host: null,
    status,
    enforcementTier: null,
    runs30d: 0,
    spend30d: null,
    tokens30d: null,
    mandates: null,
    incidents: 0,
    tamperIncidents: 0,
    tamperIncidentsRecorded: 0,
  };
}

/** A page of the workspace's agents; `nextCursor` marks it as the first of several. */
export function agentPage(
  agents: AgentPage["agents"],
  nextCursor: string | null = null,
): AgentPage {
  return {
    agents,
    nextCursor,
    totals: {
      identities: agents.length,
      retired: 0,
      enrolled: agents.filter((agent) => agent.status === "enrolled").length,
      unenrolled: agents.filter((agent) => agent.status === "unenrolled")
        .length,
      holdingMandate: 0,
      mandateHolders: [],
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  };
}

export function approvalRuleSet(
  over: Parameters<typeof approvalRuleListOutput>[0] = {},
): ApprovalRuleSet {
  return ApprovalRuleSetShape.parse(
    toApprovalRuleSet(approvalRuleListOutput(over)),
  );
}

export function connectionList(
  over: Parameters<typeof connectionListOutput>[0] = {},
): ConnectionList {
  return ConnectionListShape.parse(
    toConnectionList(connectionListOutput(over)),
  );
}

export function mcpServerList(
  over: Parameters<typeof mcpServerListOutput>[0] = {},
): McpServerList {
  return McpServerListShape.parse(toMcpServerList(mcpServerListOutput(over)));
}

const ALL_TOOLS_REF = {
  id: "tbt_alltools",
  name: "All tools",
  slug: "all-tools",
  kind: "all_tools" as const,
};
const REVIEW_REF = {
  id: "tbt_reviewbelt",
  name: "Review belt",
  slug: "review-belt",
  kind: "custom" as const,
};
const UPDATED_AT = "2026-09-20T10:00:00.000Z";

/**
 * `list_toolbelts` as the contract answers it: the All tools belt and one
 * clone of it, answered clone first so the mapper's ordering is what puts
 * All tools on top.
 */
function toolbeltListOutput(): ContractOutput<typeof toolbeltListContract> {
  return {
    items: [
      {
        ...REVIEW_REF,
        description: "What a reviewer needs",
        clonedFrom: ALL_TOOLS_REF,
        tools: 2,
        activeTools: 1,
        servers: 1,
        agents: 0,
        updatedAt: UPDATED_AT,
      },
      {
        ...ALL_TOOLS_REF,
        description: null,
        clonedFrom: null,
        tools: 3,
        activeTools: 2,
        servers: 2,
        agents: 1,
        updatedAt: UPDATED_AT,
      },
    ],
    availableTools: 3,
  };
}

export function toolbeltList(): ToolbeltList {
  return ToolbeltListShape.parse(toToolbeltList(toolbeltListOutput()));
}

/**
 * `get_toolbelt` as the contract answers it. The workspace holds three
 * groups: GitHub with two tools, Linear with one, and the declared tools with
 * one an admin made unavailable.
 *
 * - `custom` (Review belt): GitHub included with `create_issue` on and
 *   `delete_repo` off, Linear not in the belt, the declared group included.
 * - `all_tools`: every group included, each tool active as its default says
 *   while it is available.
 */
function toolbeltGetOutput(
  kind: "all_tools" | "custom" = "custom",
  agents: readonly { id: string; name: string; slug: string }[] = [],
): ContractOutput<typeof toolbeltGetContract> {
  const derived = kind === "all_tools";
  const tool = (
    id: string,
    name: string,
    state: {
      available: boolean;
      defaultActive: boolean;
      member: boolean;
      active: boolean;
    },
  ) => ({ id, slug: name, name, description: null, ...state });
  const ref = derived ? ALL_TOOLS_REF : REVIEW_REF;
  return {
    toolbelt: {
      ...ref,
      description: derived ? null : "What a reviewer needs",
      clonedFrom: derived ? null : ALL_TOOLS_REF,
      updatedAt: UPDATED_AT,
    },
    groups: [
      {
        server: { id: "mcs_github", name: "github" },
        included: true,
        tools: [
          tool("tol_createissue", "create_issue", {
            available: true,
            defaultActive: true,
            member: true,
            active: true,
          }),
          tool("tol_deleterepo", "delete_repo", {
            available: true,
            defaultActive: false,
            member: true,
            active: false,
          }),
        ],
      },
      {
        server: { id: "mcs_linear", name: "linear" },
        included: derived,
        tools: [
          tool("tol_listissues", "list_issues", {
            available: true,
            defaultActive: true,
            member: derived,
            active: derived,
          }),
        ],
      },
      {
        server: { id: null, name: "Declared tools" },
        included: true,
        tools: [
          tool("tol_summarize", "summarize", {
            available: false,
            defaultActive: true,
            member: true,
            active: false,
          }),
        ],
      },
    ],
    agents: [...agents],
  };
}

export function toolbeltDetail(
  kind: "all_tools" | "custom" = "custom",
  agents: readonly { id: string; name: string; slug: string }[] = [],
): ToolbeltDetail {
  return ToolbeltDetailShape.parse(
    toToolbeltDetail(toolbeltGetOutput(kind, agents)),
  );
}

type ToolsReads = {
  /**
   * The registry. A function answers per query, for a test whose narrowed
   * page differs from the unfiltered first page the header counts.
   */
  versions?:
    | Read<ToolVersionPage>
    | ((q: {
        category: string | null;
        cursor: string | null;
        serverId: string | null;
      }) => Read<ToolVersionPage>);
  grants?: Read<CredentialGrantPage>;
  killSwitches?: Read<KillSwitchBoard>;
  /** The Mandates tab's read (#2957); built by `@/test/mandate-views`, which
   * three features share because no feature may reach into another's folder. */
  mandates?: Read<MandateList>;
  /**
   * The agents the Mandates tab reads for a reader who may grant. Defaults to
   * one enrolled agent, since every such reader makes this read; a test that
   * cares what the picker offers hands its own.
   */
  agents?: Read<AgentPage>;
  approvalRules?: Read<ApprovalRuleSet>;
  /** The switches tab's operator picker (#3147). */
  members?: Read<MemberList>;
  /** The connections tab's own list; defaults to the two-row fixture. */
  connections?: Read<ConnectionList>;
  /** The registry tab's server roster; defaults to the two-row fixture. */
  mcpServers?: Read<McpServerList>;
  /** The Toolbelts tab's list (ADR-192); defaults to All tools and one clone. */
  toolbelts?: Read<ToolbeltList>;
  /** The belt the Toolbelts tab opens; defaults to the clone. */
  toolbelt?: Read<ToolbeltDetail>;
};

/**
 * A DataSource answering the Tools reads it was handed; `calls` records each
 * read's arguments. Every page load reads the registry's first page, the
 * provider roster and the switch board for the header and the tab strip, and
 * each tab adds its own, so every read defaults to its fixture and a test hands
 * over only the one it is about.
 */
export function toolsSource(reads: ToolsReads) {
  const calls: Record<keyof ToolsReads, unknown[][]> = {
    versions: [],
    grants: [],
    killSwitches: [],
    mandates: [],
    agents: [],
    approvalRules: [],
    members: [],
    connections: [],
    mcpServers: [],
    toolbelts: [],
    toolbelt: [],
  };
  const refuse = () => Promise.reject(new Error("not a Tools read"));
  const answer =
    <T>(read: Read<T> | undefined, name: keyof ToolsReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`tools.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
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
      list: refuse,
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
      list: answer(
        reads.agents ?? readOk(agentPage([agentPageRow("invoice-bot")])),
        "agents",
      ),
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      // Defaulted below the object literal, once `source` exists to reassign.
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    tools: {
      versions: (ctx, q) => {
        calls.versions.push([ctx, q]);
        const read = reads.versions ?? readOk(toolVersionPage());
        return Promise.resolve(typeof read === "function" ? read(q) : read);
      },
      grants: answer(reads.grants ?? readOk(credentialGrantPage()), "grants"),
      killSwitches: answer(
        reads.killSwitches ?? readOk(killSwitchBoard()),
        "killSwitches",
      ),
      approvalRules: answer(
        reads.approvalRules ?? readOk(approvalRuleSet()),
        "approvalRules",
      ),
      // Both tabs make these reads on every load beside the one under test,
      // so they default rather than making every test supply one.
      connections: answer(
        reads.connections ?? readOk(connectionList()),
        "connections",
      ),
      mcpServers: answer(
        reads.mcpServers ?? readOk(mcpServerList()),
        "mcpServers",
      ),
      toolbelts: answer(reads.toolbelts ?? readOk(toolbeltList()), "toolbelts"),
      toolbelt: answer(reads.toolbelt ?? readOk(toolbeltDetail()), "toolbelt"),
    },
    mandates: {
      list: answer(reads.mandates ?? mandateList([]), "mandates"),
      get: refuse,
    },
  };
  // The switches tab reads the org roster on every load, for the operator
  // level's picker (#3147): the same as the switch board itself, which every
  // test in this file already supplies. Defaulting to an empty roster here,
  // rather than making every switches-tab test supply one, matches how
  // little most of them care what it answers; a test that does overrides
  // `reads.members`.
  source.org.members = answer(
    reads.members ?? readOk({ members: [], invitations: [] }),
    "members",
  );
  return { source, calls };
}
