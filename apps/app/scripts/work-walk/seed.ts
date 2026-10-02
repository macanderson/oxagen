// The Work walk's seed (ADR-255, lane P1-05, #5163). CI-only:
// `.github/workflows/work-surfaces-walk.yml` runs it as
// `pnpm --filter @oxagen/app seed:work`, after `seed:e2e` and `seed:audit`,
// and nothing else does. The three e2e specs never read what it writes
// (ARCHITECTURE.md §5), and nothing under `src/` imports it (INV-07, INV-22).
//
// seed:e2e leaves the owner, e2e-org, workspace core, and the agent e2e-agent
// on the runtime e2e-runtime. The owner registered that agent, so the owner
// operates it. On top of that, this seed adds:
//
//   1. two more agents on e2e-runtime through register_agent: e2e-queued
//      (Codex) and e2e-busy (Cursor). A runtime holds one agent per harness,
//      and an agent holds one send at a time until its run ends. So the
//      waiting-for-claim item and the running item each need an agent of
//      their own, and e2e-agent stays free for the walk's own send;
//   2. one enrolled host per agent: a tacho.hosts row and its api_keys row
//      that advertise work orders and polled just now, the way
//      dispatch.pg.test.ts enrolls one;
//   3. a GitHub collector in failing health;
//   4. one work item per state in WALK_STATES (./states.ts), entered with the
//      intake library and moved with the work record store and the runtime
//      and evidence functions the handlers call.
//
// It writes e2e/.auth/work-walk.json (WORK_WALK_RECORD) for the walk.
//
// Every write runs inside runInTenantScope, in a withTenantDb transaction.
// The items, sends, claims, runs, and facts go through @oxagen/handlers'
// libraries. The hosts, their keys, and the collector have no package API
// that works without a live machine or a GitHub connection, so they go
// through @oxagen/database's typed schema, the way seed:e2e writes its
// retention policy. A refusal stops the seed with the library's own message.
//
// It is idempotent, keyed on each item's title, each agent's slug, each
// host's agent key, and the collector's name. An item already in the state
// WALK_STATES names is left alone. An item in any other state stops the seed:
// a seed that stopped partway, or a walk that already ran, moved it, and only
// a fresh database can seed it again.
//
// The package.json script sets E2E_TEST=true, as it does for seed:e2e and
// seed:audit, so every seed runs with the environment the server runs with.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { composeAgentKey } from "@oxagen/handlers/lib/run-item";
import { takesWorkOrders } from "@oxagen/handlers/lib/tacho-host";
import { enterWorkItem } from "@oxagen/handlers/lib/work-intake/actions";
import { renderGithubCollectorFile } from "@oxagen/handlers/lib/work-intake/collectors";
import {
  insertDecision,
  type NewDecision,
} from "@oxagen/handlers/lib/work-intake/triage-store";
import {
  type SendAction,
  sendWork,
} from "@oxagen/handlers/lib/work-records/actions";
import type { WorkActor } from "@oxagen/handlers/lib/work-records/actor";
import {
  type EvidenceRead,
  evidenceFacts,
} from "@oxagen/handlers/lib/work-records/evidence";
import {
  type ClaimingHost,
  claimWorkOrder,
  endWorkOrderRuns,
  linkWorkOrderRun,
} from "@oxagen/handlers/lib/work-records/runtime";
import {
  type AppendFactsInput,
  type ApproveBriefInput,
  appendFacts,
  approveBrief,
  readWorkItem,
  type SaveBriefInput,
  saveBrief,
  type WorkItemRecord,
  type WorkScope,
} from "@oxagen/handlers/lib/work-records/store";
import type { CapabilityContext } from "@oxagen/oxagen";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { AUTH_DIR, SEED } from "../../e2e/support";
import {
  WALK_CHECK,
  WALK_COLLECTOR,
  WALK_REPOSITORY,
  WALK_STATES,
  type WalkState,
  type WalkStateKey,
  WORK_WALK_RECORD,
  type WorkWalkRecord,
  workWalkRecordSchema,
} from "./states";

// ── Types the libraries already name ──────────────────────────────────────
//
// @oxagen/work and @oxagen/github are not dependencies of @oxagen/app, so
// their types are read off the handler functions that take them.

type FactIn = AppendFactsInput["facts"][number];
type Digest = ApproveBriefInput["briefDigest"];
type BriefDraft = SaveBriefInput["draft"];
type TriageOutput = NewDecision["output"];
type ItemPublicId = TriageOutput["item"];
type ReducedState = WorkItemRecord["projection"]["state"];
type PullRead = NonNullable<EvidenceRead["pull"]>;
type ChecksRead = NonNullable<EvidenceRead["checks"]>;
type RequiredRead = NonNullable<EvidenceRead["required"]>;
type Conclusion = NonNullable<ChecksRead["checkRuns"][number]["conclusion"]>;

// ── What the seed writes ──────────────────────────────────────────────────

/**
 * The feature a host advertises when it can receive work orders:
 * BUNDLE_FEATURE_WORK_ORDERS in packages/tacho/src/wire.ts. The seed checks
 * each host with `takesWorkOrders`, the gate the send itself applies.
 */
const WORK_ORDERS_FEATURE = "work_orders";

/** The host credential's purpose (TACHO_HOST_SCOPE_PURPOSE). */
const HOST_KEY_PURPOSE = "tacho_host_v1";

/** The runtime seed:e2e registers e2e-agent on. */
const RUNTIME_SLUG = "e2e-runtime";

type AgentSpec = {
  readonly slug: string;
  readonly name: string;
  readonly harness: "claude-code" | "codex" | "cursor";
};

/**
 * The three agents the seed sends to. seed:e2e registers `send`. The other
 * two take a harness e2e-runtime does not run yet, because a runtime holds
 * one agent per harness.
 */
const AGENTS = {
  send: { slug: "e2e-agent", name: "E2E agent", harness: "claude-code" },
  queued: { slug: "e2e-queued", name: "E2E queued agent", harness: "codex" },
  busy: { slug: "e2e-busy", name: "E2E busy agent", harness: "cursor" },
} as const satisfies Record<string, AgentSpec>;

/** The brief every sent item carries. buildBrief issues its keys, c1 and c2. */
const DRAFT: BriefDraft = {
  repository: WALK_REPOSITORY,
  criteria: [
    {
      text: "An expired invitation link shows the expiry message.",
      tag: "code",
      intent: "check",
      evidence: "The invitation page test passes.",
      provenance: "source",
    },
    {
      text: "The message follows the house voice.",
      tag: "review",
      intent: "review",
      provenance: "person",
    },
  ],
};

/** The two criteria triage drafts on the triage draft item. */
const TRIAGE_CRITERIA = [
  "An expired invitation link shows the expiry message.",
  "A test covers the expired link.",
];

const TRIAGE_FAILURE =
  "Triage returned no valid suggestion after 2 tries. Try 1: the output cited rule 31, and the priorities record has 18 rules. Try 2: it left the priority out. Retry triage, or set the priority yourself.";

const NEEDS_INFO_QUESTION =
  "Should an expired invitation link also show the date it expired?";

const CLOSE_REASON = "This repeats the ready invitation item.";

/** The pull request each item that reaches review names in WALK_REPOSITORY. */
const PULL_REQUESTS: Partial<Record<WalkStateKey, number>> = {
  review_passing: 101,
  review_failing: 102,
  stale_evidence: 103,
  merged_before_review: 104,
  closed_unmerged: 105,
  done: 106,
};

class SeedError extends Error {}

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(`[seed:work] ${step}`, JSON.stringify(detail));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function digestOf(text: string): Digest {
  return `sha256:${sha256Hex(text)}`;
}

/** A 40-character commit id, the same on every run for the same name. */
function commitOf(name: string): string {
  return createHash("sha1").update(`work-walk:${name}`, "utf8").digest("hex");
}

/** A run's public id for one seeded item: `tse_` and lowercase letters. */
function runIdOf(key: WalkStateKey): string {
  return `tse_walk${key.replace(/_/g, "")}`;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Lowercase letters and digits, as a host's public id takes them. */
function randomToken(length: number): string {
  return Array.from(randomBytes(length), (byte) => ALPHABET.charAt(byte % ALPHABET.length)).join("");
}

function isItemPublicId(value: string): value is ItemPublicId {
  return value.startsWith("wi_");
}

/** A send's key: `<item>:r<brief revision>:s<send>` (workOrderKey). */
function sendKeyOf(item: string, briefRevision: number, send: number): string {
  return `${item}:r${String(briefRevision)}:s${String(send)}`;
}

/** The time a moment after `earlier`, so a later provider read sorts after it. */
function after(earlier: string): string {
  return new Date(Math.max(Date.now(), Date.parse(earlier) + 1_000)).toISOString();
}

// ── Scope ─────────────────────────────────────────────────────────────────

type Ctx = {
  readonly scope: WorkScope;
  readonly ownerId: string;
  readonly actor: WorkActor;
  readonly runtime: { readonly id: string; readonly publicId: string };
};

/** One tenant transaction. Call it inside runInTenantScope. */
function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantDb(fn);
}

async function ownerUserId(): Promise<string> {
  // tenancy: seed bootstrap read of the e2e owner's user id, filtered by the seeded email; auth.users is global and carries no org_id.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, SEED.email))
      .limit(1),
  );
  const row = rows[0];
  if (!row) throw new SeedError(`${SEED.email} has no account. Run seed:e2e first.`);
  return row.id;
}

async function coreScope(): Promise<WorkScope> {
  // tenancy: seed bootstrap lookup of e2e-org and its workspace core, filtered by their slugs before any tenant scope for them exists.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ orgId: schema.organizations.id, workspaceId: schema.workspaces.id })
      .from(schema.workspaces)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
      .where(
        and(
          eq(schema.organizations.slug, SEED.orgSlug),
          eq(schema.workspaces.slug, SEED.workspaceSlug),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) {
    throw new SeedError(`${SEED.orgSlug}/${SEED.workspaceSlug} does not exist. Run seed:e2e first.`);
  }
  return row;
}

async function runtimeOf(scope: WorkScope): Promise<Ctx["runtime"]> {
  const [row] = await inTx((tx) =>
    tx
      .select({ id: schema.runtimes.id, publicId: schema.runtimes.publicId })
      .from(schema.runtimes)
      .where(
        and(
          eq(schema.runtimes.orgId, scope.orgId),
          eq(schema.runtimes.workspaceId, scope.workspaceId),
          eq(schema.runtimes.slug, RUNTIME_SLUG),
          isNull(schema.runtimes.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!row) throw new SeedError(`seed:e2e registered no runtime ${RUNTIME_SLUG}. Run seed:e2e first.`);
  return row;
}

/** A kernel context for the owner, as the app's kernel seam builds one. */
function ownerCtx(c: Ctx): CapabilityContext {
  return {
    orgId: c.scope.orgId,
    workspaceId: c.scope.workspaceId,
    userId: c.ownerId,
    apiKeyId: null,
    requestId: randomUUID(),
    surface: "app",
    messageId: null,
  };
}

// ── 1 and 2. Agents and their hosts ──────────────────────────────────────

type SeedAgent = {
  readonly id: string;
  readonly publicId: string;
  readonly slug: string;
  readonly host: ClaimingHost;
};

type Agents = Record<keyof typeof AGENTS, SeedAgent>;

async function findAgent(c: Ctx, slug: string): Promise<{ id: string; publicId: string } | null> {
  const [row] = await inTx((tx) =>
    tx
      .select({ id: schema.agents.id, publicId: schema.agents.publicId })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, c.scope.orgId),
          eq(schema.agents.workspaceId, c.scope.workspaceId),
          eq(schema.agents.slug, slug),
          isNull(schema.agents.deletedAt),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/** The agent with this slug, registered by the owner through register_agent when it is missing. */
async function seedAgentRow(c: Ctx, spec: AgentSpec, register: boolean): Promise<{ id: string; publicId: string }> {
  const existing = await findAgent(c, spec.slug);
  if (existing) return existing;
  if (!register) {
    throw new SeedError(`seed:e2e registered no agent ${spec.slug} in ${SEED.workspaceSlug}. Run seed:e2e first.`);
  }
  // The output carries the agent's credential, shown once. The seed keeps
  // none of it: its host gets a key of its own below.
  agentRegister.output.parse(
    await invoke(
      agentRegister.name,
      { name: spec.name, slug: spec.slug, harness: spec.harness, runtimeId: c.runtime.publicId },
      ownerCtx(c),
    ),
  );
  log("agent registered", { slug: spec.slug, harness: spec.harness });
  const created = await findAgent(c, spec.slug);
  if (!created) throw new SeedError(`register_agent returned, but ${spec.slug} is not readable.`);
  return created;
}

/** The agent key a host is enrolled under (ADR-024): `<org>.<workspace>.<slug>`. */
async function agentKeyOf(c: Ctx, slug: string): Promise<string> {
  const [row] = await inTx((tx) =>
    tx
      .select({ org: schema.organizations.namespace, workspace: schema.workspaces.namespace })
      .from(schema.workspaces)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
      .where(and(eq(schema.workspaces.id, c.scope.workspaceId), eq(schema.workspaces.orgId, c.scope.orgId)))
      .limit(1),
  );
  // With no namespace, the send finds the host by its agent id alone
  // (readSendTarget), so the key only has to be unique.
  return composeAgentKey(row?.org ?? null, row?.workspace ?? null, slug) ?? `${SEED.orgSlug}.${SEED.workspaceSlug}.${slug}`;
}

/**
 * The agent's enrolled host on e2e-runtime, with the key it would poll with.
 * It advertises work orders and polled just now, so a send is delivered to
 * it and the Work pages read the runtime as ready.
 */
async function enrollHost(c: Ctx, agent: { id: string; slug: string }): Promise<ClaimingHost> {
  const agentKey = await agentKeyOf(c, agent.slug);
  const hosts = schema.tachoHosts;
  const now = new Date();
  const host = await inTx(async (tx): Promise<ClaimingHost> => {
    const [existing] = await tx
      .select({ id: hosts.id, publicId: hosts.publicId })
      .from(hosts)
      .where(
        and(
          eq(hosts.orgId, c.scope.orgId),
          eq(hosts.workspaceId, c.scope.workspaceId),
          eq(hosts.agentKey, agentKey),
          ne(hosts.status, "revoked"),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(hosts)
        .set({
          agentId: agent.id,
          runtimeId: c.runtime.id,
          mode: "enforce",
          lastSeenAt: now,
          bundleFeatures: [WORK_ORDERS_FEATURE],
          updatedAt: now,
          updatedById: c.ownerId,
        })
        .where(and(eq(hosts.id, existing.id), eq(hosts.orgId, c.scope.orgId)));
      return { id: existing.id, publicId: existing.publicId, runtimeId: c.runtime.id, agentId: agent.id };
    }
    const publicId = `tch_${randomToken(22)}`;
    const token = randomToken(16);
    const [key] = await tx
      .insert(schema.apiKeys)
      .values({
        orgId: c.scope.orgId,
        workspaceId: c.scope.workspaceId,
        // No key hashes to this value, so the row grants nothing. It exists
        // because every host row names the key it polls with.
        keyPrefix: `oxk_walk${token}`,
        keyHash: `work-walk-${token}`,
        name: `Work walk host for ${agent.slug}`,
        scope: { purpose: HOST_KEY_PURPOSE, host_enrollment_id: publicId },
        createdById: c.ownerId,
      })
      .returning({ id: schema.apiKeys.id });
    if (!key) throw new SeedError(`The host key for ${agent.slug} was not written.`);
    const hostname = `${agent.slug}-host`;
    const [row] = await tx
      .insert(hosts)
      .values({
        publicId,
        orgId: c.scope.orgId,
        workspaceId: c.scope.workspaceId,
        createdById: c.ownerId,
        agentKey,
        agentId: agent.id,
        apiKeyId: key.id,
        runtimeId: c.runtime.id,
        hostname,
        hostnameDigest: digestOf(hostname),
        platform: "linux",
        osUser: "ci",
        osUserDigest: digestOf("ci"),
        devicePublicKey: `work-walk-${token}`,
        deviceKeyFingerprint: `work-walk-${token}`,
        enrollmentClaims: {},
        enrollmentSignature: "work-walk",
        expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        status: "active",
        mode: "enforce",
        lastSeenAt: now,
        bundleFeatures: [WORK_ORDERS_FEATURE],
      })
      .returning({ id: hosts.id });
    if (!row) throw new SeedError(`The host for ${agent.slug} was not written.`);
    return { id: row.id, publicId, runtimeId: c.runtime.id, agentId: agent.id };
  });
  if (!takesWorkOrders({ bundleFeatures: [WORK_ORDERS_FEATURE] })) {
    throw new SeedError(`A host that advertises ${WORK_ORDERS_FEATURE} is not offered work orders. The feature name changed; update WORK_ORDERS_FEATURE.`);
  }
  log("host enrolled", { agent: agent.slug, host: host.publicId });
  return host;
}

async function seedAgents(c: Ctx): Promise<Agents> {
  const seed = async (spec: AgentSpec, register: boolean): Promise<SeedAgent> => {
    const row = await seedAgentRow(c, spec, register);
    const host = await enrollHost(c, { id: row.id, slug: spec.slug });
    return { id: row.id, publicId: row.publicId, slug: spec.slug, host };
  };
  return {
    send: await seed(AGENTS.send, false),
    queued: await seed(AGENTS.queued, true),
    busy: await seed(AGENTS.busy, true),
  };
}

// ── 3. The collector ──────────────────────────────────────────────────────

/**
 * A GitHub collector for WALK_REPOSITORY in failing health. This job has no
 * GitHub connection, which is the honest reason it fails. The row holds the
 * hash of the collector/v1 file it mirrors, as set_work_collector writes it.
 */
async function seedCollector(c: Ctx): Promise<void> {
  const text = renderGithubCollectorFile({ name: WALK_COLLECTOR, connection: "none", repos: [WALK_REPOSITORY] });
  const collectors = schema.workCollectors;
  await inTx((tx) =>
    tx
      .insert(collectors)
      .values({
        orgId: c.scope.orgId,
        workspaceId: c.scope.workspaceId,
        createdById: c.ownerId,
        name: WALK_COLLECTOR,
        type: "github",
        connectionId: null,
        scope: { repos: [WALK_REPOSITORY] },
        health: "failing",
        fileHash: `sha256:${sha256Hex(text)}`,
      })
      .onConflictDoUpdate({
        target: [collectors.orgId, collectors.workspaceId, collectors.name],
        set: { health: "failing", updatedAt: new Date(), updatedById: c.ownerId },
      }),
  );
  log("collector seeded", { name: WALK_COLLECTOR, health: "failing" });
}

// ── 4. Work items ─────────────────────────────────────────────────────────

type Item = { readonly id: string; readonly publicId: ItemPublicId; readonly number: string };

type Sent = { readonly orderId: string; readonly orderPublicId: string };

async function findItem(c: Ctx, title: string): Promise<Item | null> {
  const items = schema.workItems;
  const [row] = await inTx((tx) =>
    tx
      .select({ id: items.id, publicId: items.publicId, number: items.number })
      .from(items)
      .where(
        and(
          eq(items.orgId, c.scope.orgId),
          eq(items.workspaceId, c.scope.workspaceId),
          eq(items.subject, title),
          isNull(items.deletedAt),
        ),
      )
      .orderBy(asc(items.createdAt))
      .limit(1),
  );
  if (!row) return null;
  if (!isItemPublicId(row.publicId)) throw new SeedError(`${row.number} has the public id ${row.publicId}, not wi_.`);
  return { id: row.id, publicId: row.publicId, number: row.number };
}

function readItem(c: Ctx, item: Item): Promise<WorkItemRecord> {
  return inTx((tx) => readWorkItem(tx, c.scope, item.id));
}

/** Enter the item the way a person does in Oxagen: manual entry records an `entered` fact on revision 1. */
async function enter(c: Ctx, state: WalkState): Promise<Item> {
  const entered = await enterWorkItem(c.scope, {
    subject: state.title,
    description: `Seeded for the Work walk (ADR-255). The walk expects this item to read ${state.status}.`,
    labels: [],
    repository: WALK_REPOSITORY,
    actorUserId: c.ownerId,
  });
  if (!isItemPublicId(entered.publicId)) {
    throw new SeedError(`${entered.number} has the public id ${entered.publicId}, not wi_.`);
  }
  return { id: entered.id, publicId: entered.publicId, number: entered.number };
}

/** A complete triage/v1 decision, as a triage run stores it. */
function triageOutput(
  item: Item,
  fields: Pick<TriageOutput, "state" | "priority" | "duplicates" | "done_record" | "questions">,
): TriageOutput {
  return {
    schema: "triage/v1",
    item: item.publicId,
    state: fields.state,
    priority: fields.priority,
    labels: ["bug"],
    estimate_minutes: 45,
    claims: [],
    duplicates: fields.duplicates,
    related: [],
    workflow: null,
    done_record: fields.done_record,
    questions: fields.questions,
    conflicts: [],
  };
}

/**
 * Store a triage decision and its triage_recorded fact in one transaction,
 * the second half of runTriage. No model ran, so the decision records none.
 */
async function recordTriage(c: Ctx, item: Item, output: TriageOutput): Promise<void> {
  await inTx(async (tx) => {
    const stored = await insertDecision(tx, c.scope, {
      itemId: item.id,
      output,
      model: null,
      promptDigest: digestOf(`work-walk prompt ${item.publicId}`),
      prioritiesHash: digestOf("work-walk priorities"),
      inputDigest: digestOf(`work-walk input ${item.publicId}`),
      costUsd: null,
      itemRevision: 1,
    });
    const fact: FactIn = {
      kind: "triage_recorded",
      source: "oxagen",
      itemRevision: 1,
      actor: "triage",
      occurredAt: new Date().toISOString(),
      dedupeKey: `triage_recorded:${stored.publicId}`,
      data: {
        decision: stored.publicId,
        outcome: output.state,
        duplicate_of: output.state === "duplicate" ? (output.duplicates[0] ?? null) : null,
      },
    };
    await appendFacts(tx, c.scope, { itemId: item.id, facts: [fact] });
  });
}

async function failTriage(c: Ctx, item: Item): Promise<void> {
  const at = new Date().toISOString();
  const fact: FactIn = {
    kind: "triage_failed",
    source: "oxagen",
    itemRevision: 1,
    actor: "triage",
    occurredAt: at,
    dedupeKey: `triage_failed:${at}`,
    data: { reason: TRIAGE_FAILURE },
  };
  await inTx((tx) => appendFacts(tx, c.scope, { itemId: item.id, facts: [fact] }));
}

/** Save the brief and approve it as the owner, so the item is ready to send. */
async function approve(c: Ctx, item: Item): Promise<void> {
  await inTx(async (tx) => {
    const before = await readWorkItem(tx, c.scope, item.id);
    const saved = await saveBrief(tx, c.scope, {
      itemId: item.id,
      expectedVersion: before.version,
      itemRevision: before.projection.revision,
      draft: DRAFT,
      actor: c.ownerId,
      source: "person",
      actorUserId: c.ownerId,
    });
    const latest = saved.projection.latestBrief;
    if (latest === null) throw new SeedError(`${item.number} saved no brief.`);
    await approveBrief(tx, c.scope, {
      itemId: item.id,
      expectedVersion: saved.version,
      itemRevision: saved.projection.revision,
      briefRevision: latest.revision,
      briefDigest: latest.digest,
      actorUserId: c.ownerId,
    });
  });
}

/**
 * Send the approved brief to one agent, with the owner as operator, through
 * the send action the handler runs. It opens the work order and queues the
 * `work_order` command for the agent's host, which the claim checks. The
 * workspace has no steering repository, so its governance mode is none.
 */
async function send(c: Ctx, item: Item, agent: SeedAgent): Promise<Sent> {
  return inTx(async (tx) => {
    const record = await readWorkItem(tx, c.scope, item.id);
    const approved = record.projection.approvedBrief;
    if (approved === null) throw new SeedError(`${item.number} has no approved brief to send.`);
    const input: SendAction = {
      item_id: item.publicId,
      version: record.version,
      item_revision: record.projection.revision,
      brief_revision: approved.revision,
      brief_digest: approved.digest,
      agent_id: agent.publicId,
      key: sendKeyOf(item.publicId, approved.revision, record.projection.nextSend),
    };
    const result = await sendWork(tx, c.scope, c.actor, input, null);
    return { orderId: result.write.orderId, orderPublicId: result.write.orderPublicId };
  });
}

/** The agent's host claims the send, and a run it started links to it. */
async function claimAndRun(c: Ctx, agent: SeedAgent, sent: Sent, runId: string): Promise<void> {
  await inTx((tx) => claimWorkOrder(tx, c.scope, agent.host, sent.orderPublicId, new Date()));
  const linked = await inTx((tx) =>
    linkWorkOrderRun(tx, c.scope, { host: agent.host, runId, workOrder: sent.orderPublicId, at: new Date() }),
  );
  if (linked !== "linked" && linked !== "repeat") {
    throw new SeedError(`Run ${runId} did not link to ${sent.orderPublicId}: ${linked}.`);
  }
}

/** The run names its pull request, as results.ts records it. */
async function linkPullRequest(c: Ctx, item: Item, agent: SeedAgent, sent: Sent, runId: string, number: number): Promise<void> {
  const fact: FactIn = {
    kind: "pr_linked",
    source: "runtime",
    itemRevision: 1,
    orderId: sent.orderId,
    repository: WALK_REPOSITORY,
    prNumber: number,
    runId,
    actor: agent.host.publicId,
    occurredAt: new Date().toISOString(),
    dedupeKey: `pr_linked:${sent.orderId}:${WALK_REPOSITORY}#${String(number)}`,
    data: {},
  };
  await inTx((tx) => appendFacts(tx, c.scope, { itemId: item.id, facts: [fact] }));
}

/** The run's seal records its end, which frees the agent for its next send. */
async function endRun(c: Ctx, runId: string): Promise<void> {
  const recorded = await inTx((tx) => endWorkOrderRuns(tx, c.scope, runId, "completed", new Date()));
  if (recorded !== 1) throw new SeedError(`Run ${runId} ended on ${String(recorded)} sends, not 1.`);
}

const REQUIRED: RequiredRead = { ok: true, names: [WALK_CHECK], sources: { protection: true, rulesets: false } };

function pullRead(head: string, at: string, end: "open" | "merged" | "closed", key: WalkStateKey): PullRead {
  const merged = end === "merged";
  return {
    headSha: head,
    baseRef: "main",
    state: end === "open" ? "open" : "closed",
    merged,
    mergeCommitSha: merged ? commitOf(`${key}:merge`) : null,
    mergedAt: merged ? at : null,
    updatedAt: at,
  };
}

function checksRead(head: string, conclusion: Conclusion, at: string): ChecksRead {
  return {
    sha: head,
    statuses: [],
    checkRuns: [
      {
        name: WALK_CHECK,
        status: "completed",
        conclusion,
        detailsUrl: null,
        startedAt: at,
        completedAt: at,
        appName: null,
      },
    ],
  };
}

/**
 * Record what a read of GitHub found, through evidenceFacts, the function
 * Accept and Read checks record their own reads with. The read is built
 * here, because this job has no GitHub connection.
 */
async function observe(c: Ctx, item: Item, sent: Sent, read: EvidenceRead): Promise<void> {
  await inTx(async (tx) => {
    const record = await readWorkItem(tx, c.scope, item.id);
    const order = record.projection.orders.find((entry) => entry.orderId === sent.orderId);
    if (order === undefined) throw new SeedError(`${item.number} has no send ${sent.orderPublicId}.`);
    const { facts } = evidenceFacts(order, read, new Date().toISOString());
    await appendFacts(tx, c.scope, { itemId: item.id, facts });
  });
}

/** The criterion keys of the item's approved brief. */
async function criteriaOf(c: Ctx, item: Item): Promise<string[]> {
  const record = await readItem(c, item);
  const approved = record.projection.approvedBrief;
  const brief = approved === null ? undefined : record.briefs.find((entry) => entry.briefId === approved.briefId);
  if (brief === undefined) throw new SeedError(`${item.number} has no approved brief.`);
  return brief.brief.criteria.map((criterion) => criterion.id);
}

/** The owner accepts the send on `head`, every criterion ticked, naming the version they read. */
async function accept(c: Ctx, item: Item, sent: Sent, head: string): Promise<void> {
  const criteria = await criteriaOf(c, item);
  await inTx(async (tx) => {
    const record = await readWorkItem(tx, c.scope, item.id);
    const approved = record.projection.approvedBrief;
    if (approved === null) throw new SeedError(`${item.number} has no approved brief to accept against.`);
    // The store sets the time, the key, the revision, and the required checks
    // under its row lock, so these are placeholders, as in accept.ts.
    const fact: FactIn = {
      kind: "accepted",
      source: "person",
      itemRevision: 1,
      orderId: sent.orderId,
      headSha: head,
      briefDigest: approved.digest,
      actor: c.ownerId,
      occurredAt: new Date(0).toISOString(),
      dedupeKey: "accepted",
      data: { criteria, required_checks: [] },
    };
    await appendFacts(tx, c.scope, {
      itemId: item.id,
      expectedVersion: record.version,
      actorUserId: c.ownerId,
      facts: [fact],
    });
  });
}

/** The owner closes the item as a duplicate, naming the version they read. */
async function closeAsDuplicate(c: Ctx, item: Item): Promise<void> {
  await inTx(async (tx) => {
    const record = await readWorkItem(tx, c.scope, item.id);
    const fact: FactIn = {
      kind: "closed",
      source: "person",
      itemRevision: 1,
      actor: c.ownerId,
      occurredAt: new Date(0).toISOString(),
      dedupeKey: "closed",
      data: { resolution: "duplicate", reason: CLOSE_REASON },
    };
    await appendFacts(tx, c.scope, {
      itemId: item.id,
      expectedVersion: record.version,
      actorUserId: c.ownerId,
      facts: [fact],
    });
  });
}

/**
 * Approve, send to e2e-agent, claim, run, link the pull request, and end the
 * run: the item waits for review. The run's end frees e2e-agent again.
 */
async function toReview(c: Ctx, agents: Agents, item: Item, key: WalkStateKey): Promise<Sent> {
  const number = PULL_REQUESTS[key];
  if (number === undefined) throw new SeedError(`${key} names no pull request.`);
  const runId = runIdOf(key);
  await approve(c, item);
  const sent = await send(c, item, agents.send);
  await claimAndRun(c, agents.send, sent, runId);
  await linkPullRequest(c, item, agents.send, sent, runId, number);
  await endRun(c, runId);
  return sent;
}

/** A read of an open pull request on `head` whose required check reported `conclusion`. */
function openRead(key: WalkStateKey, head: string, conclusion: Conclusion, at: string): EvidenceRead {
  return { pull: pullRead(head, at, "open", key), required: REQUIRED, checks: checksRead(head, conclusion, at) };
}

type Builder = (c: Ctx, agents: Agents, item: Item, seeded: ReadonlyMap<WalkStateKey, Item>) => Promise<void>;

/** What each state takes after its item is entered. */
const BUILDERS: Record<WalkStateKey, Builder> = {
  // Entered, and triage has not run: this job runs no triage.
  triaging: () => Promise.resolve(),
  triage_failed: async (c, _agents, item) => {
    await failTriage(c, item);
  },
  triage_draft: async (c, _agents, item) => {
    await recordTriage(
      c,
      item,
      triageOutput(item, {
        state: "triaged",
        priority: {
          label: "P1",
          reason: "An invitation link that fails keeps a new person out of the workspace.",
          cites: [],
        },
        duplicates: [],
        done_record: { criteria: [...TRIAGE_CRITERIA] },
        questions: [],
      }),
    );
  },
  needs_info: async (c, _agents, item) => {
    await recordTriage(
      c,
      item,
      triageOutput(item, {
        state: "needs_info",
        priority: { label: "P2", reason: "The expiry message is unclear, and no one is blocked.", cites: [] },
        duplicates: [],
        done_record: null,
        questions: [NEEDS_INFO_QUESTION],
      }),
    );
  },
  ready: async (c, _agents, item) => {
    await approve(c, item);
  },
  possible_duplicate: async (c, _agents, item, seeded) => {
    const original = seeded.get("ready");
    if (original === undefined) throw new SeedError("The ready item must be seeded before the possible duplicate.");
    await recordTriage(
      c,
      item,
      triageOutput(item, {
        state: "duplicate",
        priority: { label: "P3", reason: "It repeats an item that is ready to send.", cites: [] },
        duplicates: [original.publicId],
        done_record: null,
        questions: [],
      }),
    );
  },
  waiting_for_claim: async (c, agents, item) => {
    await approve(c, item);
    await send(c, item, agents.queued);
  },
  running: async (c, agents, item) => {
    await approve(c, item);
    const sent = await send(c, item, agents.busy);
    await claimAndRun(c, agents.busy, sent, runIdOf("running"));
  },
  review_passing: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "review_passing");
    await observe(c, item, sent, openRead("review_passing", commitOf("review_passing:a"), "success", new Date().toISOString()));
  },
  review_failing: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "review_failing");
    await observe(c, item, sent, openRead("review_failing", commitOf("review_failing:a"), "failure", new Date().toISOString()));
  },
  stale_evidence: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "stale_evidence");
    const headA = commitOf("stale_evidence:a");
    const firstAt = new Date().toISOString();
    await observe(c, item, sent, openRead("stale_evidence", headA, "success", firstAt));
    await accept(c, item, sent, headA);
    // A newer head arrives after the acceptance, with no checks read on it
    // yet. The acceptance counts for nothing on it and stays on the page.
    const headB = commitOf("stale_evidence:b");
    await observe(c, item, sent, { pull: pullRead(headB, after(firstAt), "open", "stale_evidence"), required: null, checks: null });
  },
  merged_before_review: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "merged_before_review");
    const head = commitOf("merged_before_review:a");
    const at = new Date().toISOString();
    await observe(c, item, sent, {
      pull: pullRead(head, at, "merged", "merged_before_review"),
      required: REQUIRED,
      checks: checksRead(head, "success", at),
    });
  },
  closed_unmerged: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "closed_unmerged");
    const head = commitOf("closed_unmerged:a");
    const at = new Date().toISOString();
    await observe(c, item, sent, {
      pull: pullRead(head, at, "closed", "closed_unmerged"),
      required: REQUIRED,
      checks: checksRead(head, "success", at),
    });
  },
  done: async (c, agents, item) => {
    const sent = await toReview(c, agents, item, "done");
    const head = commitOf("done:a");
    const firstAt = new Date().toISOString();
    await observe(c, item, sent, openRead("done", head, "success", firstAt));
    await accept(c, item, sent, head);
    // A person merges on GitHub. Accepted and merged is done.
    await observe(c, item, sent, { pull: pullRead(head, after(firstAt), "merged", "done"), required: null, checks: null });
  },
  closed_duplicate: async (c, _agents, item, seeded) => {
    const original = seeded.get("ready");
    if (original === undefined) throw new SeedError("The ready item must be seeded before the closed duplicate.");
    await recordTriage(
      c,
      item,
      triageOutput(item, {
        state: "duplicate",
        priority: { label: "P3", reason: "It repeats an item that is ready to send.", cites: [] },
        duplicates: [original.publicId],
        done_record: null,
        questions: [],
      }),
    );
    await closeAsDuplicate(c, item);
  },
};

function wrongState(item: Item, state: WalkState, actual: ReducedState): SeedError {
  return new SeedError(
    `${item.number} "${state.title}" is ${actual}, and the walk needs it ${state.reduced}. A seed that stopped partway, or a walk that already ran, moved it. Seed a fresh database.`,
  );
}

async function seedItems(c: Ctx, agents: Agents): Promise<Map<WalkStateKey, Item>> {
  const seeded = new Map<WalkStateKey, Item>();
  for (const state of WALK_STATES) {
    const existing = await findItem(c, state.title);
    if (existing !== null) {
      const actual = (await readItem(c, existing)).projection.state;
      if (actual !== state.reduced) throw wrongState(existing, state, actual);
      log("item already seeded", { state: state.key, number: existing.number });
      seeded.set(state.key, existing);
      continue;
    }
    const item = await enter(c, state);
    await BUILDERS[state.key](c, agents, item, seeded);
    const actual = (await readItem(c, item)).projection.state;
    if (actual !== state.reduced) throw wrongState(item, state, actual);
    log("item seeded", { state: state.key, number: item.number, reduced: actual });
    seeded.set(state.key, item);
  }
  return seeded;
}

// ── Entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ownerId = await ownerUserId();
  const scope = await coreScope();
  const record = await runInTenantScope({ ...scope, userId: ownerId }, async (): Promise<WorkWalkRecord> => {
    const c: Ctx = {
      scope,
      ownerId,
      // The role the owner's sends are recorded under: they own e2e-org.
      actor: { userId: ownerId, role: "Owner" },
      runtime: await runtimeOf(scope),
    };
    const agents = await seedAgents(c);
    await seedCollector(c);
    const seeded = await seedItems(c, agents);
    const passing = seeded.get("review_passing");
    if (passing === undefined) throw new SeedError("The review item with passing checks was not seeded.");
    const items: Partial<WorkWalkRecord["items"]> = {};
    for (const [key, item] of seeded) items[key] = { number: item.number, id: item.publicId };
    return workWalkRecordSchema.parse({
      schema: 1,
      orgSlug: SEED.orgSlug,
      workspaceSlug: SEED.workspaceSlug,
      items,
      agents: { send: agents.send.publicId, queued: agents.queued.publicId, busy: agents.busy.publicId },
      collector: WALK_COLLECTOR,
      criteria: await criteriaOf(c, passing),
    });
  });
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(WORK_WALK_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  log("done", { record: WORK_WALK_RECORD });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("[seed:work] failed", error);
    process.exit(1);
  },
);
