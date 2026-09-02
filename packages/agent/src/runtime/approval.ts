import { withTenantDb, schema } from "@oxagen/database";
import { eq, and, sql } from "drizzle-orm";
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
  const [row] = await withTenantDb((tx) =>
    tx
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
      .returning({ id: schema.approvalRequests.id }),
  );
  if (!row) throw new Error("approval insert failed");
  return { approvalId: row.id };
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
