// target.ts: the agent, runtime, host, and mandate a send goes to (P1-04).
//
// A person chooses an agent. ADR-198 binds an agent to one runtime, so the
// agent names the runtime too, and the runtime's enrolled host is the machine
// that receives the work order (`tacho.hosts`, one live host per agent key).
// Everything here is read on the server, in the caller's tenant transaction:
// the page's copy of these facts decides nothing.
//
// Three facts the send records come from here:
//
//   - Whether the sender operates the agent. ADR-198 makes an agent the IAM
//     principal of one operator, the principal's parent user, so the sender
//     operates the agent when that user is the sender (`checkSendDuties`).
//   - The mandate at send: the agent principal's active mandate whose
//     validity started last. Null when it has none. A work item adds no
//     authority, so the mandate is recorded, never widened.
//   - The runtime tier at send, a forecast from what the control plane itself
//     observed of the host (ADR-251): `contained` when the runtime requires the
//     contained launcher, `observe` when the host is in observe mode,
//     `gateway` when the control plane has authorized a gateway call on the
//     host's own credential, and `harness` otherwise. The run's own tier is
//     recorded per session at ingest. The tier says where the budget is held:
//     before a model call on `gateway` and `contained`, and after the run on
//     `harness` and `observe`.
import { schema, type Tx } from "@oxagen/database";
import { type RuntimeTier, WorkRecordError } from "@oxagen/work/records";
import { and, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { composeAgentKey } from "../run-item";
import { takesWorkOrders } from "../tacho-host";
import type { WorkScope } from "./store";

/** The host a send is delivered to. */
export interface TargetHost {
  id: string;
  publicId: string;
  hostname: string;
  lastSeenAt: Date | null;
  /** The host advertises the `work_orders` feature, so a work order reaches it. */
  takesWorkOrders: boolean;
}

/** Where a send goes, read on the server. */
export interface SendTarget {
  agentId: string;
  agentPublicId: string;
  agentName: string;
  agentPrincipalId: string | null;
  harness: string;
  runtimeId: string;
  runtimePublicId: string;
  runtimeName: string;
  runtimeTier: RuntimeTier;
  host: TargetHost;
  mandateId: string | null;
  /** The person sending operates the agent. */
  operatesAgent: boolean;
}

/** The forecast tier of a runtime at send. Pure. */
export function forecastRuntimeTier(input: {
  containmentRequired: boolean;
  hostMode: string;
  gatewayLastSeenAt: Date | null;
}): RuntimeTier {
  if (input.containmentRequired) return "contained";
  if (input.hostMode === "observe") return "observe";
  if (input.gatewayLastSeenAt !== null) return "gateway";
  return "harness";
}

function refuse(code: WorkRecordError["code"], message: string): never {
  throw new WorkRecordError(code, message);
}

async function agentKeyOf(tx: Tx, scope: WorkScope, slug: string): Promise<string | null> {
  const [row] = await tx
    .select({ org: schema.organizations.namespace, workspace: schema.workspaces.namespace })
    .from(schema.workspaces)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
    .where(and(eq(schema.workspaces.id, scope.workspaceId), eq(schema.workspaces.orgId, scope.orgId)))
    .limit(1);
  return composeAgentKey(row?.org ?? null, row?.workspace ?? null, slug);
}

/**
 * Read the target of a send to the agent `agentPublicId` (`agt_…`), for the
 * person `userId`. Refuses an agent this workspace does not hold, an agent on
 * no runtime, and a runtime with no enrolled host.
 */
export async function readSendTarget(tx: Tx, scope: WorkScope, agentPublicId: string, userId: string): Promise<SendTarget> {
  const agents = schema.agents;
  const [agent] = await tx
    .select({
      id: agents.id,
      publicId: agents.publicId,
      name: agents.name,
      slug: agents.slug,
      status: agents.status,
      harness: agents.harness,
      principalId: agents.principalId,
      runtimeId: agents.runtimeId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.publicId, agentPublicId),
        eq(agents.orgId, scope.orgId),
        eq(agents.workspaceId, scope.workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);
  if (!agent) refuse("not_found", "This workspace has no such agent.");
  if (agent.status === "archived") refuse("not_allowed", `${agent.name} is retired. Send the work to an active agent.`);
  if (agent.runtimeId === null) {
    refuse("not_allowed", `${agent.name} runs on no runtime Oxagen can reach. Send the work to an agent on an enrolled runtime.`);
  }

  const runtimes = schema.runtimes;
  const [runtime] = await tx
    .select({
      id: runtimes.id,
      publicId: runtimes.publicId,
      name: runtimes.name,
      containmentRequired: runtimes.containmentRequired,
    })
    .from(runtimes)
    .where(
      and(
        eq(runtimes.id, agent.runtimeId),
        eq(runtimes.orgId, scope.orgId),
        eq(runtimes.workspaceId, scope.workspaceId),
        isNull(runtimes.deletedAt),
      ),
    )
    .limit(1);
  if (!runtime) refuse("not_found", `${agent.name}'s runtime is not in this workspace.`);

  const hosts = schema.tachoHosts;
  const key = await agentKeyOf(tx, scope, String(agent.slug));
  const [host] = await tx
    .select({
      id: hosts.id,
      publicId: hosts.publicId,
      hostname: hosts.hostname,
      mode: hosts.mode,
      lastSeenAt: hosts.lastSeenAt,
      gatewayLastSeenAt: hosts.gatewayLastSeenAt,
      bundleFeatures: hosts.bundleFeatures,
    })
    .from(hosts)
    .where(
      and(
        eq(hosts.orgId, scope.orgId),
        eq(hosts.workspaceId, scope.workspaceId),
        ne(hosts.status, "revoked"),
        eq(hosts.runtimeId, runtime.id),
        key === null ? eq(hosts.agentId, agent.id) : or(eq(hosts.agentId, agent.id), eq(hosts.agentKey, key)),
      ),
    )
    // The host that polled last; one that never polled sorts after it.
    .orderBy(sql`${hosts.lastSeenAt} DESC NULLS LAST`)
    .limit(1);
  if (!host) {
    refuse("not_allowed", `No machine is enrolled for ${agent.name} on ${runtime.name}. Enroll it with oxagen, then send again.`);
  }

  let operatesAgent = false;
  let mandateId: string | null = null;
  if (agent.principalId !== null) {
    const [principal] = await tx
      .select({ parentUserId: schema.principals.parentUserId })
      .from(schema.principals)
      .where(and(eq(schema.principals.id, agent.principalId), eq(schema.principals.orgId, scope.orgId)))
      .limit(1);
    operatesAgent = principal?.parentUserId === userId;

    const mandates = schema.mandates;
    const now = new Date();
    const [mandate] = await tx
      .select({ id: mandates.id })
      .from(mandates)
      .where(
        and(
          eq(mandates.orgId, scope.orgId),
          eq(mandates.workspaceId, scope.workspaceId),
          eq(mandates.agentPrincipalId, agent.principalId),
          eq(mandates.status, "active"),
          lte(mandates.validFrom, now),
          or(isNull(mandates.validTo), gt(mandates.validTo, now)),
        ),
      )
      .orderBy(desc(mandates.validFrom))
      .limit(1);
    mandateId = mandate?.id ?? null;
  }

  return {
    agentId: agent.id,
    agentPublicId: agent.publicId,
    agentName: agent.name,
    agentPrincipalId: agent.principalId,
    harness: agent.harness,
    runtimeId: runtime.id,
    runtimePublicId: runtime.publicId,
    runtimeName: runtime.name,
    runtimeTier: forecastRuntimeTier({
      containmentRequired: runtime.containmentRequired,
      hostMode: host.mode,
      gatewayLastSeenAt: host.gatewayLastSeenAt,
    }),
    host: {
      id: host.id,
      publicId: host.publicId,
      hostname: host.hostname,
      lastSeenAt: host.lastSeenAt,
      takesWorkOrders: takesWorkOrders(host),
    },
    mandateId,
    operatesAgent,
  };
}
