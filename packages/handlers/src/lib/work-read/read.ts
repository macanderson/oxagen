// read.ts: the Postgres reads behind the Work pages (P1-05, #5163).
//
// Each read opens one tenant transaction (withTenantDb) and names the
// caller's org and workspace in every query, so row security and the query
// agree on the tenant. A read is bounded: the list reads the newest `limit`
// items and every related row in one query per table, never one query per
// item. Run costs come from the spend rollup (readRunTotalsByIds) after the
// transaction closes, because that read opens its own.
//
// Nothing here calls GitHub or writes anything. derive.ts, detail.ts, and
// outcomes.ts shape what these reads return.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { HOST_POLL_WINDOW_MS } from "@oxagen/oxagen/contracts/run.list";
import type { WorkItemRowOutput } from "@oxagen/oxagen/contracts/work.read.shared";
import type { WorkOutcomesGetOutput } from "@oxagen/oxagen/contracts/work.outcomes.get";
import type { WorkTargetsListOutput } from "@oxagen/oxagen/contracts/work.targets.list";
import type { Sha256Digest } from "@oxagen/run-evidence";
import {
  type TriageCorrection,
  type TriageCorrectionField,
  type TriageDecision,
  type TriageView,
  effectiveTriage,
} from "@oxagen/work";
import { type FactDataByKind, type FactKind, type WorkFact, reduceWorkItem } from "@oxagen/work/records";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { readRunTotalsByIds } from "../../spend.shared";
import { composeAgentKey } from "../run-item";
import { takesWorkOrders } from "../tacho-host";
import { itemCorrections, latestDecision } from "../work-intake/triage-store";
import { readWorkItem, type WorkScope } from "../work-records/store";
import { forecastRuntimeTier } from "../work-records/target";
import {
  type DerivedItem,
  type ItemColumns,
  type Lookups,
  type OrderRowRef,
  type RunCost,
  doneAtOf,
  itemRunIds,
  rowOf,
} from "./derive";
import { type DetailInput, type WorkItemDetail, detailOf } from "./detail";
import { type OutcomeItem, REOPEN_WAIT_DAYS, type SendOutcome, type WeekIntake, computeOutcomes } from "./outcomes";

const items = schema.workItems;
const facts = schema.workItemFacts;
const orders = schema.workOrders;
const decisions = schema.workTriageDecisions;
const corrections = schema.workTriageCorrections;
const commands = schema.tachoControlCommands;
const hosts = schema.tachoHosts;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids among `values` that are uuids, each once. A uuid column refuses any other text. */
function uuids(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) if (typeof value === "string" && UUID.test(value)) out.add(value);
  return [...out];
}

function unique(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) if (typeof value === "string" && value !== "") out.add(value);
  return [...out];
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** A work.item_facts row as a fact. The store reads its own facts the same way (store.ts). */
function rowToFact(row: typeof facts.$inferSelect): WorkFact {
  return {
    kind: row.kind as FactKind,
    source: row.source as WorkFact["source"],
    itemRevision: row.itemRevision,
    orderId: row.orderId,
    briefId: row.briefId,
    briefDigest: row.briefDigest as Sha256Digest | null,
    repository: row.repository,
    prNumber: row.prNumber,
    headSha: row.headSha,
    runId: row.runId,
    criterionId: row.criterionId,
    actor: row.actor,
    occurredAt: row.occurredAt.toISOString(),
    dedupeKey: row.dedupeKey,
    data: row.data as FactDataByKind[FactKind],
  } as WorkFact;
}

/** Every fact of the items, grouped by item, in one query. */
async function factsByItem(
  tx: Tx,
  scope: WorkScope,
  itemIds: readonly string[],
  skipKinds: readonly FactKind[] = [],
): Promise<Map<string, WorkFact[]>> {
  const out = new Map<string, WorkFact[]>();
  if (itemIds.length === 0) return out;
  const fence = and(eq(facts.orgId, scope.orgId), eq(facts.workspaceId, scope.workspaceId), inArray(facts.itemId, [...itemIds]));
  const rows = await tx
    .select()
    .from(facts)
    .where(skipKinds.length === 0 ? fence : and(fence, sql`${facts.kind} NOT IN (${sql.join(skipKinds.map((kind) => sql`${kind}`), sql`, `)})`))
    .orderBy(asc(facts.itemId), asc(facts.itemRevision), asc(facts.occurredAt), asc(facts.dedupeKey));
  for (const row of rows) {
    const list = out.get(row.itemId);
    const fact = rowToFact(row);
    if (list) list.push(fact);
    else out.set(row.itemId, [fact]);
  }
  return out;
}

/** Each item's triage view: its latest decision with every correction in force. One query each. */
async function triageByItem(tx: Tx, scope: WorkScope, itemIds: readonly string[]): Promise<Map<string, TriageView>> {
  const out = new Map<string, TriageView>();
  if (itemIds.length === 0) return out;
  const latest = await tx
    .selectDistinctOn([decisions.itemId], {
      itemId: decisions.itemId,
      publicId: decisions.publicId,
      output: decisions.output,
    })
    .from(decisions)
    .where(and(eq(decisions.orgId, scope.orgId), eq(decisions.workspaceId, scope.workspaceId), inArray(decisions.itemId, [...itemIds])))
    .orderBy(decisions.itemId, desc(decisions.createdAt), desc(decisions.id));
  const rows = await tx
    .select({
      itemId: decisions.itemId,
      field: corrections.field,
      before: corrections.before,
      after: corrections.after,
      by: corrections.by,
      at: corrections.at,
    })
    .from(corrections)
    .innerJoin(decisions, eq(decisions.id, corrections.decisionId))
    .where(
      and(
        eq(corrections.orgId, scope.orgId),
        eq(corrections.workspaceId, scope.workspaceId),
        inArray(decisions.itemId, [...itemIds]),
      ),
    )
    .orderBy(asc(corrections.at), asc(corrections.id));
  const byItem = new Map<string, TriageCorrection[]>();
  for (const row of rows) {
    const correction: TriageCorrection = {
      field: row.field as TriageCorrectionField,
      before: row.before as TriageCorrection["before"],
      after: row.after as TriageCorrection["after"],
      by: row.by,
      at: row.at.toISOString(),
    };
    const list = byItem.get(row.itemId);
    if (list) list.push(correction);
    else byItem.set(row.itemId, [correction]);
  }
  const decisionOf = new Map(latest.map((row) => [row.itemId, row]));
  for (const itemId of itemIds) {
    const decision = decisionOf.get(itemId);
    out.set(
      itemId,
      effectiveTriage(
        decision === undefined ? null : (decision.output as unknown as TriageDecision),
        decision?.publicId ?? null,
        byItem.get(itemId) ?? [],
      ),
    );
  }
  return out;
}

/** Each person's display name: the name they gave, else their email. One query. */
async function userNames(tx: Tx, userIds: Iterable<string | null | undefined>): Promise<Map<string, string | null>> {
  const ids = uuids(userIds);
  if (ids.length === 0) return new Map();
  const users = schema.users;
  const rows = await tx.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, ids));
  return new Map(
    rows.map((row) => {
      const name = row.name?.trim() ? row.name.trim() : null;
      return [row.id, name ?? (row.email ? String(row.email) : null)];
    }),
  );
}

/** Work items by public id, for a possible duplicate. One query. */
async function itemRefs(tx: Tx, scope: WorkScope, publicIds: Iterable<string | null | undefined>): Promise<Map<string, { id: string; number: string }>> {
  const ids = unique(publicIds);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ publicId: items.publicId, number: items.number })
    .from(items)
    .where(and(eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId), inArray(items.publicId, ids), isNull(items.deletedAt)));
  // The public id column is case-insensitive, so key the answer by the id as
  // the facts name it.
  const out = new Map<string, { id: string; number: string }>();
  for (const id of ids) {
    const row = rows.find((entry) => String(entry.publicId).toLowerCase() === id.toLowerCase());
    if (row) out.set(id, { id: String(row.publicId), number: row.number });
  }
  return out;
}

/** What the lookups read for. */
interface LookupScope {
  /** `waiting`: command rows only for sends waiting for their claim (a list row). `all`: for every send (one item). */
  commands: "waiting" | "all";
  /** Read mandates, and the hosts and agents that runtime and agent facts name. */
  detail: boolean;
  /** More user ids to name: correction authors, brief authors. */
  extraUserIds?: readonly string[];
}

/** The lookups for a set of items, and the display names of runtime and agent actors. One query per table. */
async function lookupsFor(
  tx: Tx,
  scope: WorkScope,
  derived: readonly DerivedItem[],
  options: LookupScope,
): Promise<{ lookups: Omit<Lookups, "runs">; actorNames: Map<string, string | null> }> {
  const allOrders = derived.flatMap((item) => item.projection.orders);
  const orderIds = uuids(allOrders.map((order) => order.orderId));
  const orderRows =
    orderIds.length === 0
      ? []
      : await tx
          .select({ id: orders.id, publicId: orders.publicId, key: orders.idempotencyKey, mandateId: orders.mandateId })
          .from(orders)
          .where(and(eq(orders.orgId, scope.orgId), eq(orders.workspaceId, scope.workspaceId), inArray(orders.id, orderIds)));
  const keyOf = new Map(orderRows.map((row) => [row.id, row.key]));

  const commandOrders =
    options.commands === "all"
      ? allOrders
      : derived.flatMap((item) => {
          const active = item.projection.activeOrder;
          return active !== null && active.delivery === "waiting_for_claim" ? [active] : [];
        });
  const keys = unique(commandOrders.map((order) => keyOf.get(order.orderId)));
  const commandRows =
    keys.length === 0
      ? []
      : await tx
          .select({ key: commands.idempotencyKey, hostId: commands.hostId, outcome: commands.outcome })
          .from(commands)
          .where(
            and(
              eq(commands.orgId, scope.orgId),
              eq(commands.workspaceId, scope.workspaceId),
              eq(commands.command, "work_order"),
              inArray(commands.idempotencyKey, keys),
            ),
          );
  const commandOf = new Map(commandRows.map((row) => [row.key ?? "", row]));

  // Runtime facts name a host by its public id (tch_…) or a run by its own
  // (tse_…). Agent facts name the agent.
  const allFacts = derived.flatMap((item) => [...item.facts]);
  const runtimeActors = options.detail ? unique(allFacts.filter((fact) => fact.source === "runtime").map((fact) => fact.actor)) : [];
  const hostPublicIds = runtimeActors.filter((actor) => actor.startsWith("tch_"));
  const runActors = runtimeActors.filter((actor) => actor.startsWith("tse_"));
  const hostIds = uuids(commandRows.map((row) => row.hostId));
  const hostConditions: SQL[] = [];
  if (hostIds.length > 0) hostConditions.push(inArray(hosts.id, hostIds));
  if (hostPublicIds.length > 0) hostConditions.push(inArray(hosts.publicId, hostPublicIds));
  const hostRows =
    hostConditions.length === 0
      ? []
      : await tx
          .select({ id: hosts.id, publicId: hosts.publicId, hostname: hosts.hostname, lastSeenAt: hosts.lastSeenAt })
          .from(hosts)
          .where(and(eq(hosts.orgId, scope.orgId), eq(hosts.workspaceId, scope.workspaceId), or(...hostConditions)));
  const hostById = new Map(hostRows.map((row) => [row.id, row]));

  const actorNames = new Map<string, string | null>();
  for (const row of hostRows) actorNames.set(String(row.publicId), row.hostname);
  if (runActors.length > 0) {
    const sessions = schema.tachoSessions;
    const runHosts = await tx
      .select({ runId: sessions.publicId, hostname: hosts.hostname })
      .from(sessions)
      .innerJoin(hosts, eq(hosts.id, sessions.hostId))
      .where(and(eq(sessions.orgId, scope.orgId), eq(sessions.workspaceId, scope.workspaceId), inArray(sessions.publicId, runActors)));
    for (const row of runHosts) actorNames.set(String(row.runId), row.hostname);
  }

  const agentActors = options.detail ? unique(allFacts.filter((fact) => fact.source === "agent").map((fact) => fact.actor)) : [];
  const agentIds = uuids([...allOrders.map((order) => order.agentId), ...agentActors]);
  const agentPublicIds = agentActors.filter((actor) => actor.startsWith("agt_"));
  const agentConditions: SQL[] = [];
  if (agentIds.length > 0) agentConditions.push(inArray(schema.agents.id, agentIds));
  if (agentPublicIds.length > 0) agentConditions.push(inArray(schema.agents.publicId, agentPublicIds));
  const agentRows =
    agentConditions.length === 0
      ? []
      : await tx
          .select({ id: schema.agents.id, publicId: schema.agents.publicId, name: schema.agents.name, harness: schema.agents.harness })
          .from(schema.agents)
          .where(and(eq(schema.agents.orgId, scope.orgId), eq(schema.agents.workspaceId, scope.workspaceId), or(...agentConditions)));
  for (const row of agentRows) {
    actorNames.set(row.id, row.name);
    actorNames.set(String(row.publicId), row.name);
  }

  const runtimeIds = uuids(allOrders.map((order) => order.runtimeId));
  const runtimeRows =
    runtimeIds.length === 0
      ? []
      : await tx
          .select({ id: schema.runtimes.id, publicId: schema.runtimes.publicId, name: schema.runtimes.name })
          .from(schema.runtimes)
          .where(and(eq(schema.runtimes.orgId, scope.orgId), eq(schema.runtimes.workspaceId, scope.workspaceId), inArray(schema.runtimes.id, runtimeIds)));

  const mandateIds = options.detail ? uuids(orderRows.map((row) => row.mandateId)) : [];
  const mandateRows =
    mandateIds.length === 0
      ? []
      : await tx
          .select({ id: schema.mandates.id, publicId: schema.mandates.publicId })
          .from(schema.mandates)
          .where(
            and(
              eq(schema.mandates.orgId, scope.orgId),
              eq(schema.mandates.workspaceId, scope.workspaceId),
              inArray(schema.mandates.id, mandateIds),
            ),
          );
  const mandateOf = new Map(mandateRows.map((row) => [row.id, String(row.publicId)]));

  const orderRefs = new Map<string, OrderRowRef>();
  for (const row of orderRows) {
    const command = commandOf.get(row.key);
    const host = command?.hostId ? hostById.get(command.hostId) : undefined;
    orderRefs.set(row.id, {
      publicId: String(row.publicId),
      mandateId: row.mandateId === null ? null : (mandateOf.get(row.mandateId) ?? null),
      host: host === undefined ? null : { name: host.hostname, lastPollAt: iso(host.lastSeenAt) },
      commandOutcome: command?.outcome ?? null,
    });
  }

  const names = await userNames(tx, [
    ...allFacts.filter((fact) => fact.source === "person").map((fact) => fact.actor),
    ...allOrders.map((order) => order.operatorId),
    ...derived.map((item) => item.triage.priority.actor),
    ...(options.extraUserIds ?? []),
  ]);
  const duplicates = await itemRefs(
    tx,
    scope,
    derived.map((item) => item.projection.triage.duplicateOf),
  );

  return {
    lookups: {
      names,
      items: duplicates,
      agents: new Map(agentRows.map((row) => [row.id, { publicId: String(row.publicId), name: row.name, harness: row.harness }])),
      runtimes: new Map(runtimeRows.map((row) => [row.id, { publicId: String(row.publicId), name: row.name }])),
      orders: orderRefs,
    },
    actorNames,
  };
}

/** What the spend rollup recorded for each run, after the tenant transaction closed. */
async function runCosts(scope: WorkScope, runIds: Iterable<string>): Promise<Map<string, RunCost>> {
  const ids = unique(runIds);
  if (ids.length === 0) return new Map();
  const totals = await readRunTotalsByIds(scope, ids);
  const out = new Map<string, RunCost>();
  for (const [runId, run] of totals) {
    out.set(runId, { costMicros: run.costMicros, currency: run.currency, basis: run.costBasis, tier: run.enforcementTier });
  }
  return out;
}

/** The work.items columns a row shows. */
const ROW_COLUMNS = {
  id: items.id,
  publicId: items.publicId,
  number: items.number,
  subject: items.subject,
  description: items.description,
  origin: items.origin,
  sourceUrl: items.sourceUrl,
  sourceRepository: items.sourceRepository,
  requester: items.requester,
  labels: items.labels,
  createdAt: items.createdAt,
  version: items.version,
  collectorId: items.collectorId,
};

type ItemRow = Pick<typeof items.$inferSelect, keyof typeof ROW_COLUMNS>;

function columnsOf(row: ItemRow): ItemColumns {
  return {
    publicId: String(row.publicId),
    number: row.number,
    title: row.subject,
    // items_origin_check holds the column to the contract's list.
    origin: row.origin as ItemColumns["origin"],
    sourceUrl: row.sourceUrl,
    repository: row.sourceRepository,
    requester: row.requester,
    labels: [...row.labels],
    arrivedAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// list_work_items
// ---------------------------------------------------------------------------

/** The list answer, less the viewer the handler adds. */
export interface WorkItemsPage {
  items: WorkItemRowOutput[];
  truncated: boolean;
}

/**
 * The workspace's newest `limit` work items by their last change, each
 * reduced from its facts. Deleted items are left out. `truncated` says more
 * items exist. The caller runs inside the tenant scope.
 */
export async function readWorkItemRows(scope: WorkScope, limit: number): Promise<WorkItemsPage> {
  const loaded = await withTenantDb(async (tx) => {
    const rows = await tx
      .select(ROW_COLUMNS)
      .from(items)
      .where(and(eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId), isNull(items.deletedAt)))
      // uuidv7 ids sort by creation, which breaks a tie in the last change.
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    const factMap = await factsByItem(tx, scope, ids);
    const triageMap = await triageByItem(tx, scope, ids);
    const derived: DerivedItem[] = page.map((row) => {
      const list = factMap.get(row.id) ?? [];
      return {
        columns: columnsOf(row),
        facts: list,
        projection: reduceWorkItem(list),
        triage: triageMap.get(row.id) ?? effectiveTriage(null, null, []),
      };
    });
    const { lookups } = await lookupsFor(tx, scope, derived, { commands: "waiting", detail: false });
    return { derived, lookups, truncated: rows.length > limit };
  });
  const runs = await runCosts(
    scope,
    loaded.derived.flatMap((item) => itemRunIds(item.projection)),
  );
  const lookups: Lookups = { ...loaded.lookups, runs };
  return { items: loaded.derived.map((item) => rowOf(item, lookups)), truncated: loaded.truncated };
}

// ---------------------------------------------------------------------------
// get_work_item
// ---------------------------------------------------------------------------

/** True when `ref` names an item by its public id (wi_…) rather than its number (WI-12). */
function isPublicId(ref: string): boolean {
  return ref.toLowerCase().startsWith("wi_");
}

/**
 * One work item by its workspace number or its public id, with everything a
 * person decides on, less the viewer the handler adds. Null when this
 * workspace has no such item, or the item was deleted. The caller runs inside
 * the tenant scope.
 */
export async function readWorkItemDetail(scope: WorkScope, ref: string): Promise<WorkItemDetail | null> {
  const wanted = ref.trim();
  const loaded = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select(ROW_COLUMNS)
      .from(items)
      .where(
        and(
          eq(items.orgId, scope.orgId),
          eq(items.workspaceId, scope.workspaceId),
          isNull(items.deletedAt),
          isPublicId(wanted) ? eq(items.publicId, wanted) : eq(items.number, wanted),
        ),
      )
      .limit(1);
    if (!row) return null;
    const record = await readWorkItem(tx, scope, row.id);
    const decision = await latestDecision(tx, scope, row.id);
    const corrected = await itemCorrections(tx, scope, row.id);
    const triage = effectiveTriage(decision?.output ?? null, decision?.publicId ?? null, corrected);
    let collector: DetailInput["collector"] = null;
    if (row.collectorId !== null) {
      const collectors = schema.workCollectors;
      const [found] = await tx
        .select({ name: collectors.name, health: collectors.health })
        .from(collectors)
        .where(and(eq(collectors.id, row.collectorId), eq(collectors.orgId, scope.orgId), eq(collectors.workspaceId, scope.workspaceId)))
        .limit(1);
      // collectors_health_check holds the column to the contract's list.
      if (found) collector = { name: found.name, health: found.health as NonNullable<DetailInput["collector"]>["health"] };
    }
    const derived: DerivedItem = {
      columns: { ...columnsOf(row), version: record.version },
      facts: record.facts,
      projection: record.projection,
      triage,
    };
    const { lookups, actorNames } = await lookupsFor(tx, scope, [derived], {
      commands: "all",
      detail: true,
      extraUserIds: [...corrected.map((correction) => correction.by), ...record.briefs.map((brief) => brief.author)],
    });
    const input: DetailInput = {
      ...derived,
      description: row.description,
      collector,
      briefs: record.briefs,
      decision: decision === null ? null : { model: decision.model, at: decision.createdAt },
      corrections: corrected,
      actorNames,
    };
    return { input, lookups };
  });
  if (loaded === null) return null;
  const runs = await runCosts(scope, itemRunIds(loaded.input.projection));
  return detailOf(loaded.input, { ...loaded.lookups, runs });
}

// ---------------------------------------------------------------------------
// list_work_targets
// ---------------------------------------------------------------------------

export type WorkTarget = WorkTargetsListOutput["agents"][number];

/**
 * The workspace's agents that are neither deleted nor retired, and whether
 * each can take a send now, read the way send_work_order reads its target
 * (target.ts) without refusing. `userId` is the person reading: an agent can
 * take a send only from the person who operates it. The caller runs inside the
 * tenant scope.
 */
export async function readWorkTargets(scope: WorkScope, userId: string | null, now: Date): Promise<WorkTarget[]> {
  return withTenantDb(async (tx) => {
    const agents = schema.agents;
    const agentRows = await tx
      .select({
        id: agents.id,
        publicId: agents.publicId,
        name: agents.name,
        slug: agents.slug,
        harness: agents.harness,
        principalId: agents.principalId,
        runtimeId: agents.runtimeId,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, scope.orgId),
          eq(agents.workspaceId, scope.workspaceId),
          isNull(agents.deletedAt),
          ne(agents.status, "archived"),
        ),
      )
      .orderBy(asc(agents.name), asc(agents.id));
    if (agentRows.length === 0) return [];

    const runtimeIds = uuids(agentRows.map((agent) => agent.runtimeId));
    const runtimes = schema.runtimes;
    const runtimeRows =
      runtimeIds.length === 0
        ? []
        : await tx
            .select({ id: runtimes.id, publicId: runtimes.publicId, name: runtimes.name, containmentRequired: runtimes.containmentRequired })
            .from(runtimes)
            .where(
              and(
                eq(runtimes.orgId, scope.orgId),
                eq(runtimes.workspaceId, scope.workspaceId),
                isNull(runtimes.deletedAt),
                inArray(runtimes.id, runtimeIds),
              ),
            );
    const runtimeOf = new Map(runtimeRows.map((row) => [row.id, row]));

    const [namespaces] = await tx
      .select({ org: schema.organizations.namespace, workspace: schema.workspaces.namespace })
      .from(schema.workspaces)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
      .where(and(eq(schema.workspaces.id, scope.workspaceId), eq(schema.workspaces.orgId, scope.orgId)))
      .limit(1);

    const hostRows =
      runtimeRows.length === 0
        ? []
        : await tx
            .select({
              runtimeId: hosts.runtimeId,
              agentId: hosts.agentId,
              agentKey: hosts.agentKey,
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
                inArray(hosts.runtimeId, runtimeRows.map((row) => row.id)),
              ),
            )
            // The host that polled last comes first, as the send picks it.
            .orderBy(sql`${hosts.lastSeenAt} DESC NULLS LAST`);

    const principalIds = uuids(agentRows.map((agent) => agent.principalId));
    const principalRows =
      principalIds.length === 0
        ? []
        : await tx
            .select({ id: schema.principals.id, parentUserId: schema.principals.parentUserId })
            .from(schema.principals)
            .where(and(eq(schema.principals.orgId, scope.orgId), inArray(schema.principals.id, principalIds)));
    const operatorOf = new Map(principalRows.map((row) => [row.id, row.parentUserId]));

    const busyRows = await tx
      .select({ agentId: orders.agentId, itemPublicId: items.publicId, number: items.number })
      .from(orders)
      .innerJoin(items, eq(items.id, orders.itemId))
      .where(
        and(
          eq(orders.orgId, scope.orgId),
          eq(orders.workspaceId, scope.workspaceId),
          isNull(orders.releasedAt),
          inArray(orders.agentId, agentRows.map((agent) => agent.id)),
        ),
      );
    const busyOf = new Map(busyRows.map((row) => [row.agentId, { id: String(row.itemPublicId), number: row.number }]));

    return agentRows.map((agent): WorkTarget => {
      const runtime = agent.runtimeId === null ? undefined : runtimeOf.get(agent.runtimeId);
      const key = composeAgentKey(namespaces?.org ?? null, namespaces?.workspace ?? null, String(agent.slug));
      const host =
        runtime === undefined
          ? undefined
          : hostRows.find((row) => row.runtimeId === runtime.id && (row.agentId === agent.id || (key !== null && row.agentKey === key)));
      const operates = userId !== null && agent.principalId !== null && operatorOf.get(agent.principalId) === userId;
      const busy = busyOf.get(agent.id) ?? null;
      const takes = host === undefined ? false : takesWorkOrders(host);
      let reason: WorkTarget["reason"] = null;
      if (runtime === undefined) reason = "no_runtime";
      else if (host === undefined) reason = "no_host";
      else if (!takes) reason = "host_outdated";
      else if (!operates) reason = "not_operator";
      else if (busy !== null) reason = "busy";
      return {
        id: String(agent.publicId),
        name: agent.name,
        harness: agent.harness,
        runtime:
          runtime === undefined
            ? null
            : {
                id: String(runtime.publicId),
                name: runtime.name,
                // With no host, the forecast has no host mode or gateway call
                // to read, so it is contained or harness.
                tier: forecastRuntimeTier({
                  containmentRequired: runtime.containmentRequired,
                  hostMode: host?.mode ?? "",
                  gatewayLastSeenAt: host?.gatewayLastSeenAt ?? null,
                }),
              },
        host: host === undefined ? null : { name: host.hostname, last_poll_at: iso(host.lastSeenAt), takes_work_orders: takes },
        operates,
        busy_with: busy,
        can_take: reason === null,
        reason,
        // A host that has not polled in the window is quiet. An agent with no
        // host reads no_host instead, so quiet stays false.
        quiet: host !== undefined && (host.lastSeenAt === null || now.getTime() - host.lastSeenAt.getTime() > HOST_POLL_WINDOW_MS),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// get_work_outcomes
// ---------------------------------------------------------------------------

/** The most items one outcomes read counts. */
const OUTCOMES_ITEMS_MAX = 2000;

/** The most sends one outcomes read counts for the delivery figures. */
const OUTCOMES_SENDS_MAX = 2000;

/** What the outcomes read loaded inside its tenant transaction. */
interface OutcomesLoad {
  items: OutcomeItem[];
  /** More items could count than the read took. */
  itemsTruncated: boolean;
  sends: SendOutcome[];
  /** More sends were made in the window than the read took. */
  sendsTruncated: boolean;
  intake: WeekIntake[];
}

/**
 * The sends a person made in the window, newest first and at most
 * OUTCOMES_SENDS_MAX of them, each with what the runtime did: its first claim,
 * and whether it was rejected or withdrawn. `truncated` says when there were
 * more sends. Deleted items' sends are left out.
 */
async function sendsInWindow(
  tx: Tx,
  scope: WorkScope,
  windowStart: Date,
  now: Date,
): Promise<{ sends: SendOutcome[]; truncated: boolean }> {
  const requested = await tx
    .select({ orderId: facts.orderId, occurredAt: facts.occurredAt })
    .from(facts)
    .innerJoin(items, eq(items.id, facts.itemId))
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        isNull(items.deletedAt),
        eq(facts.kind, "send_requested"),
        gte(facts.occurredAt, windowStart),
        lte(facts.occurredAt, now),
      ),
    )
    .orderBy(desc(facts.occurredAt), desc(facts.id))
    .limit(OUTCOMES_SENDS_MAX + 1);
  const page = requested.slice(0, OUTCOMES_SENDS_MAX);
  const orderIds = uuids(page.map((row) => row.orderId));
  const outcomeRows =
    orderIds.length === 0
      ? []
      : await tx
          .select({ orderId: facts.orderId, kind: facts.kind, occurredAt: facts.occurredAt })
          .from(facts)
          .where(
            and(
              eq(facts.orgId, scope.orgId),
              eq(facts.workspaceId, scope.workspaceId),
              inArray(facts.orderId, orderIds),
              inArray(facts.kind, ["claimed", "send_rejected", "send_withdrawn"]),
            ),
          );
  const outcomeOf = new Map<string, { claimedAt: Date | null; rejected: boolean; withdrawn: boolean }>();
  for (const row of outcomeRows) {
    if (row.orderId === null) continue;
    const entry = outcomeOf.get(row.orderId) ?? { claimedAt: null, rejected: false, withdrawn: false };
    if (row.kind === "claimed" && (entry.claimedAt === null || row.occurredAt.getTime() < entry.claimedAt.getTime())) {
      entry.claimedAt = row.occurredAt;
    }
    if (row.kind === "send_rejected") entry.rejected = true;
    if (row.kind === "send_withdrawn") entry.withdrawn = true;
    outcomeOf.set(row.orderId, entry);
  }
  const sends = page.map((row): SendOutcome => {
    const entry = row.orderId === null ? undefined : outcomeOf.get(row.orderId);
    return {
      requestedAt: row.occurredAt.toISOString(),
      claimedAt: iso(entry?.claimedAt ?? null),
      rejected: entry?.rejected ?? false,
      withdrawn: entry?.withdrawn ?? false,
    };
  });
  return { sends, truncated: requested.length > OUTCOMES_SENDS_MAX };
}

/**
 * The items that entered Work and the sends a person made in each UTC week of
 * the window, counted in the database with no cap. An item enters Work with
 * its first source reading, a collected or entered fact. Deleted items are
 * left out.
 */
async function intakeByWeek(tx: Tx, scope: WorkScope, windowStart: Date, now: Date): Promise<WeekIntake[]> {
  // occurred_at is timestamptz, so `at time zone 'UTC'` gives the UTC wall
  // time, and date_trunc('week') gives its Monday, as weekStartOf does. The
  // literals stay in the SQL text: a bound value would differ between SELECT
  // and GROUP BY, and Postgres would refuse the grouping.
  const week = sql<string>`to_char(date_trunc('week', ${facts.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await tx
    .select({ week, kind: facts.kind, n: count() })
    .from(facts)
    .innerJoin(items, eq(items.id, facts.itemId))
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        isNull(items.deletedAt),
        inArray(facts.kind, ["collected", "entered", "send_requested"]),
        gte(facts.occurredAt, windowStart),
        lte(facts.occurredAt, now),
      ),
    )
    .groupBy(week, facts.kind);
  const byWeek = new Map<string, WeekIntake>();
  for (const row of rows) {
    const entry = byWeek.get(row.week) ?? { week: row.week, entered: 0, sent: 0 };
    if (row.kind === "send_requested") entry.sent += Number(row.n);
    else entry.entered += Number(row.n);
    byWeek.set(row.week, entry);
  }
  return [...byWeek.values()];
}

/**
 * What the workspace's work finished in the last `days` days, counted from
 * the records (outcomes.ts). Reads the items with an acceptance or a merge
 * since the start of the reopen cohort, or a return or close in the window,
 * newest first and at most OUTCOMES_ITEMS_MAX of them, with their facts and
 * their triage correction counts. The check facts are left out: the figures
 * read acceptances, merges, returns, closes, and reopens, never a check, and a
 * pull request's checks are most of its facts.
 *
 * For the pilot measures it also reads the sends in the window, at most
 * OUTCOMES_SENDS_MAX of them, and each week's entered and sent counts, which
 * have no cap. `truncated` says when the items ran past their cap, and
 * `delivery.truncated` when the sends did. The caller runs inside the tenant
 * scope.
 */
export async function readWorkOutcomes(scope: WorkScope, days: number, now: Date): Promise<WorkOutcomesGetOutput> {
  const windowStart = new Date(now.getTime() - days * DAY_MS);
  const cohortStart = new Date(now.getTime() - (REOPEN_WAIT_DAYS + days) * DAY_MS);
  const loaded = await withTenantDb(async (tx): Promise<OutcomesLoad> => {
    const candidates = await tx
      .selectDistinct({ itemId: facts.itemId })
      .from(facts)
      .innerJoin(items, eq(items.id, facts.itemId))
      .where(
        and(
          eq(facts.orgId, scope.orgId),
          eq(facts.workspaceId, scope.workspaceId),
          isNull(items.deletedAt),
          or(
            and(inArray(facts.kind, ["accepted", "merged"]), gte(facts.occurredAt, cohortStart)),
            and(inArray(facts.kind, ["returned", "closed"]), gte(facts.occurredAt, windowStart)),
          ),
        ),
      )
      // Item ids are UUIDv7, so the newest items sort first.
      .orderBy(desc(facts.itemId))
      .limit(OUTCOMES_ITEMS_MAX + 1);
    const ids = candidates.slice(0, OUTCOMES_ITEMS_MAX).map((row) => row.itemId);
    const factMap = await factsByItem(tx, scope, ids, ["checks_required", "check_observed"]);
    const correctionCounts =
      ids.length === 0
        ? []
        : await tx
            .select({ itemId: decisions.itemId, n: count() })
            .from(corrections)
            .innerJoin(decisions, eq(decisions.id, corrections.decisionId))
            .where(and(eq(corrections.orgId, scope.orgId), eq(corrections.workspaceId, scope.workspaceId), inArray(decisions.itemId, ids)))
            .groupBy(decisions.itemId);
    const correctionsOf = new Map(correctionCounts.map((row) => [row.itemId, Number(row.n)]));
    const outcomeItems = ids.map((itemId): OutcomeItem => {
      const list = factMap.get(itemId) ?? [];
      return { facts: list, projection: reduceWorkItem(list), corrections: correctionsOf.get(itemId) ?? 0 };
    });
    const sent = await sendsInWindow(tx, scope, windowStart, now);
    const intake = await intakeByWeek(tx, scope, windowStart, now);
    return {
      items: outcomeItems,
      itemsTruncated: candidates.length > OUTCOMES_ITEMS_MAX,
      sends: sent.sends,
      sendsTruncated: sent.truncated,
      intake,
    };
  });
  // Price only the runs of items done in the window: those are the ones the
  // cost figure sums.
  const doneInWindow = loaded.items.filter((item) =>
    item.projection.orders.some((order) => {
      const at = doneAtOf(order);
      return at !== null && Date.parse(at) >= windowStart.getTime() && Date.parse(at) <= now.getTime();
    }),
  );
  const runs = await runCosts(
    scope,
    doneInWindow.flatMap((item) => itemRunIds(item.projection)),
  );
  return {
    ...computeOutcomes({ now, days, items: loaded.items, runs, sends: loaded.sends, sendsTruncated: loaded.sendsTruncated, intake: loaded.intake }),
    truncated: loaded.itemsTruncated,
  };
}
