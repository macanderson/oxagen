import { db, schema } from "@oxagen/database";
import { eq, and, sql } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import postgres from "postgres";

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

let listenerStarted = false;
let listenSql: ReturnType<typeof postgres> | null = null;

async function ensureListener(): Promise<void> {
  if (listenerStarted) return;
  const env = requireEnv(["DATABASE_URL"] as const);
  // A dedicated single-connection client; the pooled `db()` client cannot
  // hold a long-lived LISTEN.
  listenSql = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  await listenSql.listen(NOTIFY_CHANNEL, (payload) => {
    try {
      const data = JSON.parse(payload) as ApprovalResolution;
      const w = waiters.get(data.approvalId);
      if (w) {
        waiters.delete(data.approvalId);
        w(data);
      }
    } catch {
      // Malformed payload — ignore.
    }
  });
  listenerStarted = true;
}

export async function createApprovalRequest(
  args: CreateApprovalArgs,
): Promise<{ approvalId: string }> {
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS));
  const [row] = await db()
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
    waiters.set(approvalId, resolve);
    setTimeout(() => {
      if (waiters.delete(approvalId)) {
        resolve({ approvalId, resolution: "expired", note: null });
      }
    }, ttlMs);
  });
}

// Called from the agent.approval.resolve handler after it updates the DB.
export async function notifyResolution(r: ApprovalResolution): Promise<void> {
  const payload = JSON.stringify(r);
  // Use drizzle sql tagged-template so channel and payload are passed as bound
  // parameters — no user-controlled string is ever concatenated into SQL.
  await db().execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${payload})`);
}

// Used by handlers that need a tenant-scoped lookup before update.
export async function readApproval(approvalId: string, orgId: string) {
  const [row] = await db()
    .select()
    .from(schema.approvalRequests)
    .where(
      and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.orgId, orgId)),
    )
    .limit(1);
  return row ?? null;
}
