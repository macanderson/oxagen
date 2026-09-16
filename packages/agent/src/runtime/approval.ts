import { withTenantDb, schema } from "@oxagen/database";
import { APPROVAL_RESOLVER_ROLES } from "./approval-roles";
import { eq, and, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import postgres from "postgres";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.approval" },
});

// Default expiry window for an approval request. Approvals that age out
// resolve to `expired` server-side rather than dangling forever.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * The most people one approval notifies. `APPROVAL_RESOLVER_ROLES.workspace`
 * is Owner and Member — effectively everyone — so an unbounded fan-out writes
 * one row per member of the workspace inside the approval's transaction. A
 * 400-member workspace parks one write and holds a 400-row insert; near 8,000
 * it crosses Postgres's 65,535 bind-parameter ceiling and the approval itself
 * fails, so the person never gets the card the fan-out existed to deliver.
 *
 * Past the cap the approval is still written and still resolvable — the feed
 * is a convenience, the approval row is the record — and the truncation is
 * logged with the count so it is visible rather than silent.
 */
export const APPROVAL_NOTIFY_MAX_RECIPIENTS = 200;

/** Rows per insert statement, so one statement never approaches the ceiling. */
export const APPROVAL_NOTIFY_CHUNK = 50;

export interface CreateApprovalArgs {
  orgId: string;
  workspaceId: string;
  messageId: string;
  capabilityName: string;
  inputPreview: unknown;
  riskLevel: "low" | "medium" | "high";
  executionStepId?: string | null;
  toolCallId?: string | null;
  ttlMs?: number;
}

export interface ApprovalResolution {
  approvalId: string;
  resolution: "approved" | "denied" | "expired";
  note: string | null;
}

// Channel name passed to NOTIFY/LISTEN. Receiver subscribes once per
// process and demuxes by approvalId from the payload.
const NOTIFY_CHANNEL = "agent_approval_resolved";

// Per-process listener; awaiters register here and the LISTEN connection
// resolves the matching entry when a row resolves.
const waiters = new Map<string, (r: ApprovalResolution) => void>();

let listenSql: ReturnType<typeof postgres> | null = null;
// `listenerReady` is the synchronous fast-path flag (set once init resolves) so
// repeat callers short-circuit without adding a microtask hop.
// `listenerPromise` is the shared, memoized initialization promise: concurrent
// first-callers (serverless cold-start fan-out) must NOT each allocate a
// postgres() client and race to overwrite listenSql — the loser would be
// orphaned and its idle connection would leak forever (closeApprovalListener
// only closes the surviving reference). Awaiting the one promise guarantees
// exactly one client is created no matter how many callers arrive at once.
let listenerReady = false;
let listenerPromise: Promise<void> | null = null;

async function ensureListener(): Promise<void> {
  if (listenerReady) return;
  if (!listenerPromise) {
    listenerPromise = (async () => {
      const env = requireEnv(["DATABASE_URL"] as const);
      // A dedicated single-connection client; the pooled `db()` client cannot
      // hold a long-lived LISTEN.
      const client = postgres(env.DATABASE_URL, { max: 1, prepare: false });
      try {
        await client.listen(NOTIFY_CHANNEL, (payload) => {
          try {
            const data = JSON.parse(payload) as ApprovalResolution;
            const w = waiters.get(data.approvalId);
            if (w) {
              waiters.delete(data.approvalId);
              w(data);
            }
          } catch (err) {
            // A malformed or truncated NOTIFY payload (PG's 8000-byte limit,
            // schema drift, encoding issue) must be logged so ops can detect
            // systematic corruption. The registered waiter stays in the Map and
            // will resolve as "expired" after its TTL — the correct fallback for
            // a single corrupted notification. We deliberately do NOT resolve
            // any waiter here.
            logger.warn(
              { err, payload },
              "malformed NOTIFY payload on channel agent_approval_resolved",
            );
          }
        });
      } catch (err) {
        // Init failed — close the half-open client and clear the memo so a later
        // call can retry instead of being stuck on a rejected promise.
        await client.end().catch(() => {});
        listenerPromise = null;
        throw err;
      }
      listenSql = client;
      listenerReady = true;
    })();
  }
  await listenerPromise;
}

export async function createApprovalRequest(
  args: CreateApprovalArgs,
): Promise<{ approvalId: string }> {
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS));
  const approvalId = await withTenantDb(async (tx) => {
    // One live approval per parked call. `approvalMode: "park"` throws rather
    // than blocking, so the model sees a failed tool call and may ask again for
    // the same call — without this, each retry writes a fresh approval and
    // another fan-out, and the person is asked to answer the same write several
    // times. The key is the call: the turn's message, the capability, and the
    // engine's tool-call id when there is one.
    //
    // Scoped to unresolved rows, so a call denied once can be asked again.
    // This closes the retry case, which is sequential inside one turn; two
    // processes parking the same call at the same instant would still write
    // two rows. The durable close is a partial unique index on
    // (workspace_id, message_id, capability_name, tool_call_id) NULLS NOT
    // DISTINCT WHERE resolution IS NULL, which needs a migration this worktree
    // cannot hash (no atlas binary) or verify (no database).
    const existing = await findLiveApproval(tx, args);
    if (existing) return existing;

    const [row] = await tx
      .insert(schema.approvalRequests)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        messageId: args.messageId,
        capabilityName: args.capabilityName,
        inputPreview: args.inputPreview as object,
        riskLevel: args.riskLevel,
        executionStepId: args.executionStepId ?? null,
        toolCallId: args.toolCallId ?? null,
        expiresAt,
      })
      .returning({ id: schema.approvalRequests.id });
    if (!row) throw new Error("approval insert failed");

    // MC spec §7.7 approval.requested: one feed row per person who may
    // resolve it, written with the approval so neither exists without the other.
    const { approvers, truncated } = await approverUserIds(
      tx,
      args.orgId,
      args.workspaceId,
    );
    if (truncated) {
      logger.warn(
        {
          orgId: args.orgId,
          workspaceId: args.workspaceId,
          capabilityName: args.capabilityName,
          notified: approvers.length,
        },
        "approval.requested fan-out truncated: more people may resolve this approval than the cap notifies",
      );
    }
    for (let i = 0; i < approvers.length; i += APPROVAL_NOTIFY_CHUNK) {
      await tx.insert(schema.notifications).values(
        approvers.slice(i, i + APPROVAL_NOTIFY_CHUNK).map((userId) => ({
          orgId: args.orgId,
          workspaceId: args.workspaceId,
          userId,
          kind: "approval" as const,
          event: "approval.requested" as const,
          title: `Approval requested: ${args.capabilityName}`,
          body: `Risk ${args.riskLevel}. Expires ${expiresAt.toISOString()}.`,
          deepLink: null,
        })),
      );
    }
    return row.id;
  });
  return { approvalId };
}

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

/**
 * The people resolve_approval admits, resolved the way its gate resolves
 * them (`assertOrgRole` in @oxagen/iam): an active human principal in the
 * org holding an undeleted, unexpired assignment of an admitted role, either
 * org-wide (`workspace_id IS NULL`) or on this workspace.
 */
async function approverUserIds(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<{ approvers: string[]; truncated: boolean }> {
  const p = schema.principals;
  const pra = schema.principalRoleAssignments;
  const roles = schema.roles;
  const rows = await tx
    .select({ userId: p.parentUserId })
    .from(p)
    .innerJoin(pra, eq(pra.principalId, p.id))
    .innerJoin(roles, eq(roles.id, pra.roleId))
    .where(
      and(
        eq(p.orgId, orgId),
        eq(p.kind, "human"),
        eq(p.status, "active"),
        eq(pra.orgId, orgId),
        isNull(pra.deletedAt),
        or(isNull(pra.expiresAt), gt(pra.expiresAt, new Date())),
        or(
          and(
            eq(roles.scopeKind, "org"),
            isNull(pra.workspaceId),
            inArray(roles.name, APPROVAL_RESOLVER_ROLES.org),
          ),
          and(
            eq(roles.scopeKind, "workspace"),
            eq(pra.workspaceId, workspaceId),
            inArray(roles.name, APPROVAL_RESOLVER_ROLES.workspace),
          ),
        ),
      ),
    )
    // One person can hold several admitted roles, so rows outnumber people;
    // read one page past the cap on distinct users rather than guessing.
    .limit((APPROVAL_NOTIFY_MAX_RECIPIENTS + 1) * 4);
  const distinct = [
    ...new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId]))),
  ];
  return {
    approvers: distinct.slice(0, APPROVAL_NOTIFY_MAX_RECIPIENTS),
    truncated: distinct.length > APPROVAL_NOTIFY_MAX_RECIPIENTS,
  };
}

/**
 * An unresolved approval already standing for this exact parked call, if one
 * is. Expired rows are excluded: an approval past its window cannot be
 * answered, so reusing it would park the retry on something nobody can act on.
 */
async function findLiveApproval(
  tx: Tx,
  args: CreateApprovalArgs,
): Promise<string | null> {
  const a = schema.approvalRequests;
  const [row] = await tx
    .select({ id: a.id })
    .from(a)
    .where(
      and(
        eq(a.orgId, args.orgId),
        eq(a.workspaceId, args.workspaceId),
        eq(a.messageId, args.messageId),
        eq(a.capabilityName, args.capabilityName),
        args.toolCallId
          ? eq(a.toolCallId, args.toolCallId)
          : isNull(a.toolCallId),
        isNull(a.resolution),
        gt(a.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

// Pauses execution until the approval resolves (via PG NOTIFY) or the
// TTL elapses. Returns the resolution either way.
export async function waitForApproval(
  approvalId: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<ApprovalResolution> {
  await ensureListener();
  return new Promise<ApprovalResolution>((resolve) => {
    // The TTL timer is cleared the moment NOTIFY resolves the waiter. An
    // uncleared timer keeps a ref on the event loop for the full TTL, so a
    // worker that has drained its queue cannot exit until the last approval's
    // window elapses — even though the approval was answered seconds in.
    // Both callbacks below only ever run asynchronously, so arming the timer
    // first (keeping it `const`) cannot fire before the waiter is registered.
    const timer = setTimeout(() => {
      if (waiters.delete(approvalId)) {
        resolve({ approvalId, resolution: "expired", note: null });
      }
    }, ttlMs);
    waiters.set(approvalId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

// Closes the PG NOTIFY listener connection and resets module state.
// Register this with process SIGTERM/SIGINT handlers in host apps, and call
// it in afterAll/afterEach blocks in tests that need clean module isolation
// (instead of relying on vi.resetModules()).
export async function closeApprovalListener(): Promise<void> {
  if (!listenerPromise) return;
  // Wait for any in-flight initialization to settle so we never end() a client
  // that ensureListener is still assigning to listenSql.
  await listenerPromise.catch(() => {});
  await listenSql?.end();
  listenSql = null;
  listenerPromise = null;
  listenerReady = false;
  waiters.clear();
}

// Called from the agent.approval.resolve handler after it updates the DB.
export async function notifyResolution(r: ApprovalResolution): Promise<void> {
  const payload = JSON.stringify(r);
  // Use drizzle sql tagged-template so channel and payload are passed as bound
  // parameters — no user-controlled string is ever concatenated into SQL.
  await withTenantDb((tx) =>
    tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${payload})`),
  );
}

// Used by handlers that need a tenant-scoped lookup before update.
export async function readApproval(approvalId: string, orgId: string) {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.approvalRequests.id,
        orgId: schema.approvalRequests.orgId,
        resolution: schema.approvalRequests.resolution,
        expiresAt: schema.approvalRequests.expiresAt,
      })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.id, approvalId),
          eq(schema.approvalRequests.orgId, orgId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}
