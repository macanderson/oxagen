// The three Tools reads to the page's view models (ARCHITECTURE.md §3.4).
// Typed from each contract's `_output`, so a field the contract may leave null
// cannot land in a required view field, and every figure is copied as the
// handler counted it — no count, digest or duration is computed here.
import type { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import type { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import type { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import type { z } from "zod";
import type {
  CredentialGrantPage,
  KillSwitchBoard,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { ContractOutput } from "@/server/kernel";

export function toToolVersionPage(
  out: ContractOutput<typeof toolVersionList>,
): z.input<typeof ToolVersionPage> {
  return {
    items: out.items.map((item) => ({
      id: item.id,
      toolId: item.toolId,
      slug: item.slug,
      name: item.name,
      description: item.description,
      version: item.version,
      source: item.source,
      serverId: item.serverId,
      capability: item.capabilityId,
      readOnly: item.readOnly,
      riskGrade: item.riskGrade,
      classification:
        item.classification === null
          ? null
          : {
              sideEffect: item.classification.sideEffect,
              egress: item.classification.egress,
              consequenceTags: item.classification.consequenceTags,
              dataClasses: item.classification.dataClasses,
              measures: Object.keys(item.classification.measures),
            },
      classifiedAt: item.classifiedAt,
      schemaOrigin: item.schemaOrigin,
      schemaDigest: item.schemaDigest,
      enabled: item.enabled,
      gate: { kind: item.gate.kind, switchId: item.gate.switchId },
      calls30d: item.calls30d,
      updatedAt: item.updatedAt,
    })),
    nextCursor: out.nextCursor,
  };
}

export function toCredentialGrantPage(
  out: ContractOutput<typeof credentialGrantList>,
): z.input<typeof CredentialGrantPage> {
  return {
    items: out.items.map((item) => ({
      id: item.id,
      connectionId: item.connectionId,
      serverId: item.serverId,
      serverName: item.serverName,
      runId: item.runId,
      scope: {
        endpointUrl: item.scope.endpointUrl,
        authKind: item.scope.authKind,
        downscope: item.scope.downscope,
      },
      issuedAt: item.issuedAt,
      expiresAt: item.expiresAt,
      revokedAt: item.revokedAt,
      status: item.status,
    })),
    nextCursor: out.nextCursor,
  };
}

export function toKillSwitchBoard(
  out: ContractOutput<typeof killSwitchList>,
): z.input<typeof KillSwitchBoard> {
  return {
    denyGeneration: {
      org: out.denyGeneration.org,
      workspace: out.denyGeneration.workspace,
    },
    switches: out.switches.map((item) => ({
      id: item.id,
      target: { kind: item.target.kind, ref: item.target.id },
      scope: item.scope,
      on: item.on,
      reason: item.reason,
      flippedByRef: item.flippedBy,
      flippedAt: item.flippedAt,
      clearedAt: item.clearedAt,
      clearedByRef: item.clearedBy,
    })),
  };
}
