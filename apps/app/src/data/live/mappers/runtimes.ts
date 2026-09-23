// list_tacho_hosts and list_agents outputs to the Runtimes view models
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`.
//
// The host summary also carries `tiers`, a tier per harness resolved from the
// harness's name (`packages/handlers/src/tacho.host.list.ts` `tiersFor`). It is
// not mapped: a tier is computed per run from what was actually routed, and a
// value looked up from a name would print a tier no run earned (INV-10).
import type { agentList } from "@oxagen/oxagen/contracts/agent.list";
import type { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import type { z } from "zod";
import type {
  ModelRoute,
  RuntimeAgent,
  RuntimeEnrollment,
} from "@/data/contracts/runtimes";
import type { ContractOutput } from "@/server/kernel";

type HostSummary = ContractOutput<typeof tachoHostList>["hosts"][number];
type AgentItem = ContractOutput<typeof agentList>["items"][number];

/**
 * What the harness configs on this machine name for model traffic, as last
 * reported. `loopback` needs every report to name the proxy: a host where
 * Claude Code is routed and Codex goes direct is `mixed`, because reading it
 * as routed would claim the proxy sees calls it never sees.
 */
export function modelRouteOf(host: HostSummary): {
  route: ModelRoute | null;
  shadowedBy: string | null;
} {
  const reports = host.modelBaseUrls;
  if (reports.length === 0) return { route: null, shadowedBy: null };
  const shadowed = reports.find((report) => report.shadowedBy !== null);
  const routed = reports.filter((report) => report.ours).length;
  return {
    route:
      routed === reports.length
        ? "loopback"
        : routed === 0
          ? "direct"
          : "mixed",
    shadowedBy: shadowed?.shadowedBy ?? null,
  };
}

export function toRuntimeEnrollment(
  host: HostSummary,
): z.input<typeof RuntimeEnrollment> {
  const { route, shadowedBy } = modelRouteOf(host);
  return {
    id: host.hostEnrollmentId,
    hostname: host.hostname,
    platform: host.platform,
    osUser: host.osUser,
    status: host.status,
    mode: host.mode,
    harnesses: host.harnesses,
    claudeVersionAtEnroll: host.claudeVersionAtEnroll,
    collectorVersion: host.wrapperVersion,
    modelRoute: route,
    shadowedBy,
    hooksOk: host.hooksOk,
    lastSeenAt: host.lastSeenAt,
    createdAt: host.createdAt,
    expiresAt: host.expiresAt,
    revokedAt: host.revokedAt,
    agentKey: host.agentKey,
  };
}

/** An agent row, or null for one whose key namespaces were never backfilled: no enrollment can name it. */
export function toRuntimeAgent(
  item: AgentItem,
): z.input<typeof RuntimeAgent> | null {
  if (item.agentKey === null) return null;
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    agentKey: item.agentKey,
    harness: item.harness,
    operatorId: item.operatorId,
    principalId: item.principalId,
    runs30d: item.runs30d,
  };
}
