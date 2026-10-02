/**
 * run-work-order.ts — the work order a run belongs to (F13, #4638).
 *
 * Every run has a parent work order (wasted-spend.html, Operator
 * productivity, Unassigned spend). The spend rollup resolves it each time it
 * rebuilds the run's `cost.run_totals` row, in this order:
 *
 * 1. A send that a `run_linked` fact ties the run to. The runtime reports the
 *    fact and the work record store checks it (ADR-244), so this is the
 *    strongest link.
 * 2. A send the run's frames claim with the OTLP attribute
 *    `oxagen.work_order.id`. The daemon re-keys that attribute as a client
 *    claim, so the rollup accepts it only when it names a send in the run's
 *    org and workspace that was sent to the run's own agent. A run with no
 *    agent principal cannot prove a claim, so its claims are not read.
 * 3. Otherwise the run's direct work order, opened the first time the rollup
 *    sees the run. One run has at most one.
 *
 * A send found on a later rebuild replaces the direct work order on the
 * run's row. The direct work order stays, unattached, and no spend points at
 * it.
 *
 * The rollup runs outside a tenant scope, so each read and write here opens
 * the run's own tenant scope and goes through withTenantDb, where the work
 * records live. Every query also names the run's org and workspace.
 */
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { readRunWorkOrderClaims } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, or } from "drizzle-orm";
import type { RunMeta } from "./cost-rollup";

/** What a run's work order is: a send (`work.orders`) or a direct work order (`work.direct_orders`). */
export type RunWorkOrderKind = "send" | "direct";

/** The work order a run belongs to. `id` is the row's uuid in the table `kind` names. */
export interface RunWorkOrder {
  id: string;
  kind: RunWorkOrderKind;
}

/** The parts of a run the resolver reads. */
export interface RunWorkOrderSource {
  meta: RunMeta;
  frames:
    | { kind: "ledger" }
    | { kind: "tacho"; rootSessionUuid: string; sessionUuids: readonly string[] };
}

interface Scope {
  orgId: string;
  workspaceId: string;
}

/** The reads and the one write the resolver makes. Tests pass fakes. */
export interface RunWorkOrderDeps {
  /** The send a `run_linked` fact ties the run to, or null. */
  readLinkedSend: (scope: Scope, runId: string) => Promise<string | null>;
  /** The work order ids the run's frames claim, the earliest first. */
  readClaims: (source: RunWorkOrderSource) => Promise<string[]>;
  /**
   * The send's uuid when `claim` names a send in the scope that went to the
   * agent with this principal, by its public id or its uuid. Null otherwise.
   */
  verifyClaim: (scope: Scope, claim: string, agentPrincipalId: string) => Promise<string | null>;
  /** Open the run's direct work order, or read the one it already has. Returns its uuid. */
  openDirectOrder: (meta: RunMeta) => Promise<string>;
}

const facts = schema.workItemFacts;
const orders = schema.workOrders;
const directOrders = schema.workDirectOrders;
const agents = schema.agents;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run fn in the run's own tenant scope. */
function inRunScope<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTenantScope({ orgId: scope.orgId, workspaceId: scope.workspaceId }, () => withTenantDb(fn));
}

async function readLinkedSend(scope: Scope, runId: string): Promise<string | null> {
  const rows = await inRunScope(scope, (tx) =>
    tx
      .select({ orderId: facts.orderId })
      .from(facts)
      .where(
        and(
          eq(facts.orgId, scope.orgId),
          eq(facts.workspaceId, scope.workspaceId),
          eq(facts.kind, "run_linked"),
          eq(facts.runId, runId),
        ),
      )
      .orderBy(asc(facts.occurredAt), asc(facts.createdAt))
      .limit(1),
  );
  return rows[0]?.orderId ?? null;
}

async function readClaims(source: RunWorkOrderSource): Promise<string[]> {
  // A ledger run's events carry no OTLP attributes.
  if (source.frames.kind !== "tacho") return [];
  return readRunWorkOrderClaims({
    orgId: source.meta.orgId,
    workspaceId: source.meta.workspaceId,
    rootSessionUuid: source.frames.rootSessionUuid,
    sessionUuids: source.frames.sessionUuids,
  });
}

async function verifyClaim(scope: Scope, claim: string, agentPrincipalId: string): Promise<string | null> {
  const named = UUID.test(claim)
    ? or(eq(orders.publicId, claim), eq(orders.id, claim))
    : eq(orders.publicId, claim);
  const rows = await inRunScope(scope, (tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(agents, and(eq(agents.id, orders.agentId), eq(agents.orgId, orders.orgId)))
      .where(
        and(
          eq(orders.orgId, scope.orgId),
          eq(orders.workspaceId, scope.workspaceId),
          named,
          eq(agents.principalId, agentPrincipalId),
        ),
      )
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

async function openDirectOrder(meta: RunMeta): Promise<string> {
  // A run's public id is unique across tenants, so the conflict target finds
  // only this run's row.
  return inRunScope(meta, async (tx) => {
    const [opened] = await tx
      .insert(directOrders)
      .values({
        orgId: meta.orgId,
        workspaceId: meta.workspaceId,
        runId: meta.runId,
        operatorPrincipalId: meta.operatorPrincipalId,
        agentPrincipalId: meta.agentPrincipalId,
        openedAt: meta.startedAt,
      })
      .onConflictDoNothing({ target: directOrders.runId })
      .returning({ id: directOrders.id });
    if (opened) return opened.id;
    const [existing] = await tx
      .select({ id: directOrders.id })
      .from(directOrders)
      .where(
        and(
          eq(directOrders.runId, meta.runId),
          eq(directOrders.orgId, meta.orgId),
          eq(directOrders.workspaceId, meta.workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error(
        `work.direct_orders holds run ${meta.runId} under another workspace, so the rollup cannot open its direct work order.`,
      );
    }
    return existing.id;
  });
}

export const productionRunWorkOrderDeps: RunWorkOrderDeps = {
  readLinkedSend,
  readClaims,
  verifyClaim,
  openDirectOrder,
};

/** The work order a run belongs to. See the file comment for the order of the checks. */
export async function resolveRunWorkOrder(
  source: RunWorkOrderSource,
  deps: RunWorkOrderDeps = productionRunWorkOrderDeps,
): Promise<RunWorkOrder> {
  const { meta } = source;
  const scope = { orgId: meta.orgId, workspaceId: meta.workspaceId };
  const linked = await deps.readLinkedSend(scope, meta.runId);
  if (linked !== null) return { id: linked, kind: "send" };
  const agent = meta.agentPrincipalId;
  if (agent !== null) {
    for (const claim of await deps.readClaims(source)) {
      const send = await deps.verifyClaim(scope, claim, agent);
      if (send !== null) return { id: send, kind: "send" };
    }
  }
  return { id: await deps.openDirectOrder(meta), kind: "direct" };
}
