// Typed Runtimes values for the Runtimes component tests (ARCHITECTURE.md §5):
// host enrollments, agents, and a DataSource that answers the runtimes reads
// with what a test hands it. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type {
  NamedRuntime,
  NamedRuntimeList,
  RuntimeAgent,
  RuntimeAgents,
  RuntimeEnrollment,
  RuntimeList,
} from "@/data/contracts/runtimes";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

export function enrollment(
  overrides: Partial<RuntimeEnrollment> = {},
): RuntimeEnrollment {
  return {
    id: "tch_mbellmbp16aaaaaaaaaaaaa",
    hostname: "mbell-mbp-16",
    platform: "darwin",
    osVersion: "15.6",
    arch: "arm64",
    osUser: "mbell",
    status: "active",
    mode: "enforce",
    harnesses: ["claude-code"],
    claudeVersionAtEnroll: "2.1.4",
    collectorVersion: "1.6.2",
    modelRoute: "loopback",
    shadowedBy: null,
    managed: false,
    hooksOk: null,
    lastSeenAt: "2026-09-23T09:12:44.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2099-09-01T10:00:00.000Z",
    revokedAt: null,
    agentKey: "acme.core.release-manager",
    ...overrides,
  };
}

export function runtimeAgent(
  overrides: Partial<RuntimeAgent> = {},
): RuntimeAgent {
  return {
    id: "agt_releasemanager",
    slug: "release-manager",
    name: "Release manager",
    agentKey: "acme.core.release-manager",
    harness: "claude-code",
    operatorId: "usr_marcusbell",
    principalId: "prn_01JQ8W3F2M6XKD7A9RZT4BVCNE",
    runs30d: 212,
    ...overrides,
  };
}

export function runtimeList(
  enrollments: RuntimeEnrollment[],
  more = false,
): Read<RuntimeList> {
  return readOk({ enrollments, more });
}

/** A runtime the workspace named (ADR-198), running Claude Code as `mac-claude`. */
export function namedRuntime(
  overrides: Partial<NamedRuntime> = {},
): NamedRuntime {
  return {
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
    lastSeenAt: "2026-09-23T09:12:44.000Z",
    ...overrides,
  };
}

export function namedRuntimeList(
  runtimes: NamedRuntime[] = [namedRuntime()],
): Read<NamedRuntimeList> {
  return readOk({ runtimes });
}

/** The organization's roster, holding the operator `runtimeAgent()` names. */
export function memberList(
  members: MemberList["members"] = [
    {
      id: "usr_marcusbell",
      name: "Marcus Bell",
      email: "marcus@acme.test",
      avatarUrl: null,
      role: "owner",
      joinedAt: "2026-01-05T09:00:00.000Z",
    },
  ],
): Read<MemberList> {
  return readOk({ members, invitations: [] });
}

/**
 * A DataSource whose runtimes port answers with the reads given, recording
 * each call, and whose org port answers the roster the detail page names an
 * operator from.
 */
export function runtimesSource(reads: {
  list: Read<RuntimeList>;
  agents?: Read<RuntimeAgents>;
  members?: Read<MemberList>;
  /** `list_runtimes`; no runtime named when absent. */
  named?: Read<NamedRuntimeList>;
}): {
  source: DataSource;
  calls: { agents: (readonly string[])[]; members: number };
} {
  const calls: { agents: (readonly string[])[]; members: number } = {
    agents: [],
    members: 0,
  };
  // Only the runtimes port and the roster are read by these pages; every
  // other read refuses, so a page that reaches for one fails its test.
  const refuse = () => Promise.reject(new Error("not a Runtimes read"));
  const runtimes: DataSource["runtimes"] = {
    list: () => Promise.resolve(reads.list),
    agents: (_ctx, keys) => {
      calls.agents.push(keys);
      return Promise.resolve(
        reads.agents ?? readOk({ agents: [runtimeAgent()] }),
      );
    },
    named: () => Promise.resolve(reads.named ?? namedRuntimeList([])),
  };
  const members: DataSource["org"]["members"] = () => {
    calls.members += 1;
    return Promise.resolve(reads.members ?? memberList());
  };
  const source: DataSource = {
    runtimes,
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
      issues: refuse,
      context: refuse,
      findings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse },
    agents: { list: refuse, get: refuse, toolbelt: refuse, incidents: refuse },
    mandates: { list: refuse, get: refuse },
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
      members,
      roles: refuse,
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
      deliveries: refuse,
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
      toolbelts: refuse,
      toolbelt: refuse,
    },
  };

  return { source, calls };
}
