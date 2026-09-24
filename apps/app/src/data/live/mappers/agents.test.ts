// The Agents mappers over sample contract outputs: every recorded field carried
// as the contract wrote it, a null the store left kept null, a cost in
// canonical micros with its basis, and each incident severity named.
import type { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import type { agentList } from "@oxagen/oxagen/contracts/agent.list";
import type { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import type { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { describe, expect, it } from "vitest";
import {
  AgentDetail,
  AgentPage,
  IncidentPage,
  Toolbelt,
} from "@/data/contracts/agents";
import type { ContractOutput } from "@/server/kernel";
import {
  toAgentDetail,
  toAgentPage,
  toIncidentPage,
  toToolbelt,
} from "./agents";

type Item = ContractOutput<typeof agentList>["items"][number];

const recorded: Item = {
  id: "agt_releasebot",
  slug: "release-bot",
  name: "Release bot",
  description: "Cuts releases and opens their pull requests.",
  agentKey: "acme.core.release-bot",
  harness: "claude-code",
  principalId: "prn_91",
  operatorId: "usr_marcusbell",
  operatorName: "Marcus Bell",
  status: "enrolled",
  tier: null,
  enforcementTier: "gateway",
  beltSize: null,
  runs30d: 42,
  spend30d: { micros: "0012500000", currency: "USD", basis: "client_attested" },
  tokens30d: {
    total: 1_400,
    input: 1_000,
    cacheRead: 600,
    cacheReadRate: 0.6,
    sessions: 3,
  },
  proven30d: null,
  mandates: 2,
  incidents: 1,
  tamperIncidents: 1,
  tamperIncidentsRecorded: 2,
  credentials: 1,
  hosts: 1,
  host: "build-01",
  registeredAt: "2026-09-01T10:00:00.000Z",
};

const bare: Item = {
  ...recorded,
  id: "agt_legacy",
  slug: "legacy",
  description: null,
  agentKey: null,
  operatorId: null,
  operatorName: null,
  status: "unenrolled",
  enforcementTier: null,
  runs30d: 0,
  spend30d: null,
  tokens30d: null,
  mandates: null,
  incidents: 0,
  tamperIncidents: 0,
  tamperIncidentsRecorded: 0,
  host: null,
};

describe("toAgentPage", () => {
  it("carries each row and the workspace totals, with spend in canonical micros and its basis", () => {
    const tamper = {
      recorded: 3,
      open: 2,
      newest: {
        agentKey: "acme.core.release-bot",
        kind: "hooks_removed",
        detectedAt: "2026-09-11T09:16:04.000Z",
      },
    };
    const page = toAgentPage({
      items: [recorded, bare],
      nextCursor: "c2",
      totals: {
        identities: 7,
        enrolled: 5,
        unenrolled: 1,
        holdingMandate: 1,
        mandateHolders: ["acme.core.release-bot"],
        tamperIncidents: 2,
        tamper,
      },
    });
    expect(page).toEqual({
      agents: [
        {
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
          spend30d: {
            micros: "12500000",
            currency: "USD",
            basis: "client_attested",
          },
          tokens30d: { total: 1_400, cacheReadRate: 0.6, sessions: 3 },
          mandates: 2,
          incidents: 1,
          tamperIncidents: 1,
          tamperIncidentsRecorded: 2,
        },
        {
          id: "agt_legacy",
          slug: "legacy",
          name: "Release bot",
          description: null,
          agentKey: null,
          harness: "claude-code",
          operatorId: null,
          operatorName: null,
          principalId: "prn_91",
          credentials: 1,
          hosts: 1,
          host: null,
          status: "unenrolled",
          enforcementTier: null,
          runs30d: 0,
          spend30d: null,
          tokens30d: null,
          mandates: null,
          incidents: 0,
          tamperIncidents: 0,
          tamperIncidentsRecorded: 0,
        },
      ],
      nextCursor: "c2",
      totals: {
        identities: 7,
        enrolled: 5,
        unenrolled: 1,
        holdingMandate: 1,
        mandateHolders: ["acme.core.release-bot"],
        tamperIncidents: 2,
        tamper,
      },
    });
    expect(AgentPage.safeParse(page).success).toBe(true);
  });
});

const detail: ContractOutput<typeof agentGet> = {
  identity: {
    id: "agt_releasebot",
    slug: "release-bot",
    name: "Release bot",
    description: null,
    agentKey: "acme.core.release-bot",
    harness: "claude-code",
    principalId: null,
    operatorId: "usr_marcusbell",
    status: "suspended",
    registeredAt: "2026-09-01T10:00:00.000Z",
    firstFrameAt: null,
    costCenter: "ENG-1001",
  },
  credentials: [
    {
      id: "aky_1",
      name: "release-bot",
      prefix: "oxa_ag_7f",
      createdAt: "2026-09-01T10:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    },
  ],
  roles: [
    {
      id: "rol_ci",
      name: "CI writer",
      scopeKind: "workspace",
      isSystemDefault: false,
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
      harnesses: ["claude-code"],
      deviceKeyFingerprint: "sha256:ab12",
      collectorVersion: null,
      hooksOk: null,
      bundleVersionServed: null,
      lastSeenAt: null,
      expiresAt: "2027-09-01T10:00:00.000Z",
      revokedAt: null,
    },
  ],
  definition: null,
};

describe("toAgentDetail", () => {
  it("carries the identity, credentials, roles and hosts, keeping every unrecorded field null", () => {
    const view = toAgentDetail(detail);
    expect(view.identity).toEqual({
      id: "agt_releasebot",
      slug: "release-bot",
      name: "Release bot",
      description: null,
      agentKey: "acme.core.release-bot",
      harness: "claude-code",
      principalId: null,
      operatorId: "usr_marcusbell",
      status: "suspended",
      registeredAt: "2026-09-01T10:00:00.000Z",
      firstFrameAt: null,
      costCenter: "ENG-1001",
    });
    expect(view.roles).toEqual([
      {
        id: "rol_ci",
        name: "CI writer",
        scopeKind: "workspace",
        assignedAt: "2026-09-02T10:00:00.000Z",
        expiresAt: null,
      },
    ]);
    expect(view.hosts[0]).toMatchObject({
      hostEnrollmentId: "tch_0123456789abcdefghijkl",
      collectorVersion: null,
      hooksOk: null,
      bundleVersionServed: null,
      lastSeenAt: null,
    });
    expect(view.definition).toBeNull();
    expect(AgentDetail.safeParse(view).success).toBe(true);
  });

  it("carries a committed definition with its source, commit and pull request", () => {
    const view = toAgentDetail({
      ...detail,
      definition: {
        version: 3,
        path: ".oxagen/agents/release-bot.toml",
        digest: "a".repeat(64),
        commitSha: "9c1e2f0",
        branch: "agents/release-bot",
        pullRequestUrl: "https://github.com/acme/core/pull/12",
        source: 'slug = "release-bot"\n',
        committedAt: "2026-09-03T10:00:00.000Z",
      },
    });
    expect(view.definition).toEqual({
      path: ".oxagen/agents/release-bot.toml",
      digest: "a".repeat(64),
      commitSha: "9c1e2f0",
      branch: "agents/release-bot",
      pullRequestUrl: "https://github.com/acme/core/pull/12",
      source: 'slug = "release-bot"\n',
      committedAt: "2026-09-03T10:00:00.000Z",
    });
  });
});

describe("toToolbelt", () => {
  it("carries how the belt was computed, what the model receives, each tool's decision and what the agent cannot see", () => {
    const out: ContractOutput<typeof agentToolbeltGet> = {
      agentId: "agt_releasebot",
      agentKey: null,
      computedAt: "2026-09-15T09:00:00.000Z",
      basis: {
        humanCeiling: "sentinel",
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
          category: null,
          riskLevel: "medium",
          decision: "require_approval",
          rule: "agent:7:role_grant",
          readOnly: false,
        },
      ],
      cannotSee: [
        {
          name: "delete_repository",
          kind: "capability",
          server: null,
          rule: "human:8:default",
        },
      ],
    };
    const view = toToolbelt(out);
    expect(view).toEqual({
      computedAt: "2026-09-15T09:00:00.000Z",
      computation: {
        humanCeiling: "sentinel",
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
          category: null,
          riskLevel: "medium",
          decision: "require_approval",
          rule: "agent:7:role_grant",
          readOnly: false,
          inputSchema: null,
          schemaOrigin: null,
          schemaDigest: null,
          schemaTruncated: false,
        },
      ],
      cannotSee: [
        {
          name: "delete_repository",
          kind: "capability",
          server: null,
          rule: "human:8:default",
        },
      ],
    });
    expect(Toolbelt.safeParse(view).success).toBe(true);
  });
});

describe("toIncidentPage", () => {
  const incident: ContractOutput<typeof tachoIncidentList>["items"][number] = {
    id: "tin_1",
    kind: "hooks_removed",
    severity: 10,
    detectedAt: "2026-09-14T10:00:00.000Z",
    detectedBy: "collector",
    hostEnrollmentId: null,
    sessionId: null,
    agentKey: null,
    evidence: {},
    resolvedAt: null,
    resolutionNote: null,
  };

  it.each([
    [1, "notice"],
    [3, "warning"],
    [10, "tamper"],
  ] as const)("names severity %i %s", (severity, name) => {
    const view = toIncidentPage({
      items: [{ ...incident, severity }],
      nextCursor: null,
    });
    expect(view.incidents[0]?.severity).toBe(name);
  });

  it("carries a resolved incident on a session with its note and the next cursor", () => {
    const view = toIncidentPage({
      items: [
        {
          ...incident,
          sessionId: "tse_4f0a",
          resolvedAt: "2026-09-14T11:00:00.000Z",
          resolutionNote: "hooks rewritten by the operator",
        },
      ],
      nextCursor: "c2",
    });
    expect(view).toEqual({
      incidents: [
        {
          id: "tin_1",
          kind: "hooks_removed",
          severity: "tamper",
          detectedAt: "2026-09-14T10:00:00.000Z",
          detectedBy: "collector",
          sessionId: "tse_4f0a",
          resolvedAt: "2026-09-14T11:00:00.000Z",
          resolutionNote: "hooks rewritten by the operator",
        },
      ],
      nextCursor: "c2",
    });
    expect(IncidentPage.safeParse(view).success).toBe(true);
  });
});
