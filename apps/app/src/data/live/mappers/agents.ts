// list_agents, get_agent, get_agent_toolbelt and list_incidents outputs to the
// Agents view models (ARCHITECTURE.md §3.4). Typed from each contract's
// `_output`, so a field the contract may omit cannot land in a required view
// field; mappers.type-test.ts holds the reverse direction.
import type { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import type { agentList } from "@oxagen/oxagen/contracts/agent.list";
import type { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import type { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import type { z } from "zod";
import type {
  AgentDetail,
  AgentPage,
  IncidentPage,
  Toolbelt,
} from "@/data/contracts/agents";
import { moneyFromMicros } from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";

type AgentListOutput = ContractOutput<typeof agentList>;
type IncidentOutput = ContractOutput<typeof tachoIncidentList>["items"][number];

export function toAgentPage(out: AgentListOutput): z.input<typeof AgentPage> {
  return {
    agents: out.items.map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      description: item.description,
      agentKey: item.agentKey,
      harness: item.harness,
      operatorId: item.operatorId,
      operatorName: item.operatorName,
      principalId: item.principalId,
      credentials: item.credentials,
      hosts: item.hosts,
      host: item.host,
      status: item.status,
      enforcementTier: item.enforcementTier,
      runs30d: item.runs30d,
      spend30d:
        item.spend30d === null
          ? null
          : {
              ...moneyFromMicros(item.spend30d.micros, item.spend30d.currency),
              basis: item.spend30d.basis,
            },
      tokens30d:
        item.tokens30d === null
          ? null
          : {
              total: item.tokens30d.total,
              cacheReadRate: item.tokens30d.cacheReadRate,
              sessions: item.tokens30d.sessions,
            },
      mandates: item.mandates,
      incidents: item.incidents,
      tamperIncidents: item.tamperIncidents,
      tamperIncidentsRecorded: item.tamperIncidentsRecorded,
    })),
    nextCursor: out.nextCursor,
    totals: {
      identities: out.totals.identities,
      enrolled: out.totals.enrolled,
      unenrolled: out.totals.unenrolled,
      holdingMandate: out.totals.holdingMandate,
      mandateHolders: out.totals.mandateHolders,
      tamperIncidents: out.totals.tamperIncidents,
      tamper: out.totals.tamper,
    },
  };
}

export function toAgentDetail(
  out: ContractOutput<typeof agentGet>,
): z.input<typeof AgentDetail> {
  return {
    identity: {
      id: out.identity.id,
      slug: out.identity.slug,
      name: out.identity.name,
      description: out.identity.description,
      agentKey: out.identity.agentKey,
      harness: out.identity.harness,
      principalId: out.identity.principalId,
      operatorId: out.identity.operatorId,
      status: out.identity.status,
      registeredAt: out.identity.registeredAt,
      firstFrameAt: out.identity.firstFrameAt,
      costCenter: out.identity.costCenter,
    },
    credentials: out.credentials.map((credential) => ({
      id: credential.id,
      name: credential.name,
      prefix: credential.prefix,
      createdAt: credential.createdAt,
      expiresAt: credential.expiresAt,
      lastUsedAt: credential.lastUsedAt,
      revokedAt: credential.revokedAt,
    })),
    roles: out.roles.map((role) => ({
      id: role.id,
      name: role.name,
      scopeKind: role.scopeKind,
      assignedAt: role.assignedAt,
      expiresAt: role.expiresAt,
    })),
    hosts: out.hosts.map((host) => ({
      hostEnrollmentId: host.hostEnrollmentId,
      hostname: host.hostname,
      platform: host.platform,
      status: host.status,
      mode: host.mode,
      deviceKeyFingerprint: host.deviceKeyFingerprint,
      collectorVersion: host.collectorVersion,
      hooksOk: host.hooksOk,
      bundleVersionServed: host.bundleVersionServed,
      lastSeenAt: host.lastSeenAt,
      expiresAt: host.expiresAt,
      revokedAt: host.revokedAt,
    })),
    definition:
      out.definition === null
        ? null
        : {
            path: out.definition.path,
            digest: out.definition.digest,
            commitSha: out.definition.commitSha,
            branch: out.definition.branch,
            pullRequestUrl: out.definition.pullRequestUrl,
            source: out.definition.source,
            committedAt: out.definition.committedAt,
          },
  };
}

export function toToolbelt(
  out: ContractOutput<typeof agentToolbeltGet>,
): z.input<typeof Toolbelt> {
  return {
    computedAt: out.computedAt,
    computation: {
      humanCeiling: out.basis.humanCeiling,
      roleGrants: out.basis.roleGrants,
      denyGeneration: {
        org: out.basis.denyGeneration.org,
        workspace: out.basis.denyGeneration.workspace,
      },
      killSwitches: out.basis.killSwitches,
    },
    presentation: {
      mode: out.presentation.mode,
      limit: out.presentation.limit,
      sentToModel: out.presentation.sentToModel,
    },
    tools: out.tools.map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      server: tool.server,
      category: tool.category,
      riskLevel: tool.riskLevel,
      decision: tool.decision,
      rule: tool.rule,
      readOnly: tool.readOnly,
      // The four schema fields are optional on the contract, so a control
      // plane that predates them reports no schema rather than undefined.
      inputSchema: tool.inputSchema ?? null,
      schemaOrigin: tool.schemaOrigin ?? null,
      schemaDigest: tool.schemaDigest ?? null,
      schemaTruncated: tool.schemaTruncated ?? false,
    })),
    cannotSee: out.cannotSee.map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      server: tool.server,
      rule: tool.rule,
    })),
  };
}

const SEVERITY = {
  1: "notice",
  3: "warning",
  10: "tamper",
} as const satisfies Record<IncidentOutput["severity"], string>;

export function toIncidentPage(
  out: ContractOutput<typeof tachoIncidentList>,
): z.input<typeof IncidentPage> {
  return {
    incidents: out.items.map((incident) => ({
      id: incident.id,
      kind: incident.kind,
      severity: SEVERITY[incident.severity],
      detectedAt: incident.detectedAt,
      detectedBy: incident.detectedBy,
      sessionId: incident.sessionId,
      resolvedAt: incident.resolvedAt,
      resolutionNote: incident.resolutionNote,
    })),
    nextCursor: out.nextCursor,
  };
}
