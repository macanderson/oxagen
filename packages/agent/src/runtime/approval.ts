import { withTenantDb, schema } from "@oxagen/database";
import { inputDigest } from "@oxagen/rules";
import { notifyApprovalRequested } from "@oxagen/rules/approval-notify";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import postgres from "postgres";
import pino from "pino";
import {
  ApprovalResumeError,
  encryptApprovalResume,
} from "./approval-resume-payload";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.approval" },
});

// Default expiry window for an approval request. Approvals that age out
// resolve to `expired` server-side rather than dangling forever.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// The fan-out's own bounds live beside the fan-out, in @oxagen/rules: there
// are two writers of an approval row and only one place that tells people
// about it. Re-exported here because this module is where they were first
// read from, and the cap is part of this module's contract with its callers.
export {
  APPROVAL_NOTIFY_CHUNK,
  APPROVAL_NOTIFY_MAX_RECIPIENTS,
} from "@oxagen/rules/approval-notify";

export interface CreateApprovalArgs {
  orgId: string;
  workspaceId: string;
  messageId: string;
  capabilityName: string;
  inputPreview: unknown;
  /**
   * The capability input this approval is for, when it is the value `invoke()`
   * will receive. Its canonical digest is what a rule's standing window is
   * keyed on, so a person approving THIS card can satisfy a later window for
   * the same call.
   *
   * Pass it only where the value provably matches what the decision path
   * digests. Omit it and the row stores a null digest, which is what it did
   * before: no standing match, and the next call asks a person again.
   */
  digestInput?: unknown;
  riskLevel: "low" | "medium" | "high";
  executionStepId?: string | null;
  toolCallId?: string | null;
  /**
   * The run this call was parked in, as `agent_runs.id` (#3286). The approval
   * row records the run's PUBLIC id, because both kinds of run the Run page
   * shows have to be representable and no one table holds both, so this is
   * resolved to one inside the write.
   *
   * Omit it where no run is in scope. A null on the row means "not recorded",
   * never "some other run".
   */
  runId?: string | null;
  ttlMs?: number;
  resumeRequesterUserId?: string;
}

/** `agent_runs.id` is a uuid; anything else is a caller's sentinel, not a run. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public id of the run a parked call belongs to, or null.
 *
 * The chat gate holds the run's internal id (`ctx.agentRun.runId`) and the
 * column records the public one, so the write resolves it — one primary-key
 * read per parked call. A value that is not a uuid is a caller's sentinel
 * (the tool-belt read uses one) and names no run; a uuid with no row is a run
 * this workspace does not hold. Both record null rather than a reference the
 * Run page would fail to resolve.
 */
export async function resolveRunPublicId(
  tx: Tx,
  args: { orgId: string; workspaceId: string; runId?: string | null },
): Promise<string | null> {
  if (!args.runId || !UUID.test(args.runId)) return null;
  const [row] = await tx
    .select({ publicId: schema.agentRuns.publicId })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.id, args.runId),
        eq(schema.agentRuns.orgId, args.orgId),
        eq(schema.agentRuns.workspaceId, args.workspaceId),
      ),
    )
    .limit(1);
  return row?.publicId ?? null;
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

export async function createApprovalRequest(args: CreateApprovalArgs): Promise<{
  /** The row uuid, which waiters and NOTIFY are keyed by. */
  approvalId: string;
  /**
   * The public id (`apr_…`) that list reads, Fleet and a parked card show.
   * Absent only from a test double that returns no public id.
   */
  publicId?: string;
  resolution?: string | null;
  resumeStatus?: string | null;
  expiresAt?: Date;
}> {
  if (args.resumeRequesterUserId) return createResumableApproval(args);
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS));
  // An ordinary approval row used to store no digest at all, so a person's
  // decision here could never satisfy a rule's standing window and the next
  // identical call asked again. That is friction rather than exposure, which
  // is why it is safe to fix — and why the fix must not overshoot: a digest
  // computed over a DIFFERENT value than the decision path digests would
  // produce a false match, turning the friction into a skipped person.
  //
  // `inputDigest` refuses a value it cannot encode (see its contract), and a
  // refusal here must not stop an approval card from being written. A throw
  // leaves the digest null, which is exactly the old behaviour: no standing
  // match, a person is asked.
  let digest: string | null = null;
  if (args.digestInput !== undefined) {
    try {
      digest = inputDigest(args.digestInput);
    } catch {
      digest = null;
    }
  }
  const recorded = await withTenantDb(async (tx) => {
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
        runPublicId: await resolveRunPublicId(tx, args),
        inputDigest: digest,
        expiresAt,
      })
      .returning({
        id: schema.approvalRequests.id,
        publicId: schema.approvalRequests.publicId,
      });
    if (!row) throw new Error("approval insert failed");

    // MC spec §7.7 approval.requested, written with the approval so neither
    // exists without the other. Shared with the mandate gate's own insert,
    // which parks a call when an `alwaysHumanFor` or `humanAbove` rule fires:
    // the fan-out belongs to the approval row, not to one of its writers.
    await notifyApprovalRequested(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      capabilityName: args.capabilityName,
      riskLevel: args.riskLevel,
      expiresAt,
    });
    return row;
  });
  return { approvalId: recorded.id, publicId: recorded.publicId };
}

async function createResumableApproval(args: CreateApprovalArgs) {
  const requesterUserId = args.resumeRequesterUserId!;
  const digest = inputDigest(args.digestInput);
  const payload = await encryptApprovalResume({
    version: 1,
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    requesterUserId,
    messageId: args.messageId,
    capabilityName: args.capabilityName,
    rawInput: args.inputPreview,
    validatedDigest: digest,
    riskLevel: args.riskLevel,
  });
  return withTenantDb(async (tx) => {
    const message = await tx.query.messages.findFirst({
      where: and(
        eq(schema.messages.id, args.messageId),
        eq(schema.messages.orgId, args.orgId),
        eq(schema.messages.workspaceId, args.workspaceId),
      ),
    });
    const conversation =
      message &&
      (await tx.query.conversations.findFirst({
        where: and(
          eq(schema.conversations.id, message.conversationId),
          eq(schema.conversations.orgId, args.orgId),
          eq(schema.conversations.workspaceId, args.workspaceId),
          eq(schema.conversations.userId, requesterUserId),
        ),
      }));
    if (!conversation)
      throw new ApprovalResumeError("requester_conversation_missing");
    const resumeKey = inputDigest({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      conversationId: conversation.id,
      requesterUserId,
      capability: args.capabilityName,
      digest,
    });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${resumeKey}, 0))`,
    );
    const a = schema.approvalRequests;
    const existing = await tx.query.approvalRequests.findFirst({
      where: and(
        eq(a.orgId, args.orgId),
        eq(a.workspaceId, args.workspaceId),
        eq(a.resumeKey, resumeKey),
        gt(a.expiresAt, new Date()),
      ),
    });
    if (existing)
      return {
        approvalId: existing.id,
        publicId: existing.publicId,
        resolution: existing.resolution,
        resumeStatus: existing.resumeStatus,
        expiresAt: existing.expiresAt,
      };
    const expiresAt = new Date(Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS));
    const [row] = await tx
      .insert(a)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        messageId: args.messageId,
        capabilityName: args.capabilityName,
        inputPreview: { inputDigest: digest },
        inputDigest: digest,
        riskLevel: args.riskLevel,
        expiresAt,
        runPublicId: await resolveRunPublicId(tx, args),
        resumeKey,
        resumePayload: payload,
        resumeStatus: "waiting",
      })
      .returning({ approvalId: a.id, publicId: a.publicId });
    if (!row) throw new ApprovalResumeError("approval_not_recorded");
    await notifyApprovalRequested(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      capabilityName: args.capabilityName,
      riskLevel: args.riskLevel,
      expiresAt,
    });
    return { ...row, resolution: null, resumeStatus: "waiting", expiresAt };
  });
}

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

/**
 * An unresolved approval already standing for this exact parked call, if one
 * is. Expired rows are excluded: an approval past its window cannot be
 * answered, so reusing it would park the retry on something nobody can act on.
 */
async function findLiveApproval(
  tx: Tx,
  args: CreateApprovalArgs,
): Promise<{ id: string; publicId: string } | null> {
  const a = schema.approvalRequests;
  const [row] = await tx
    .select({ id: a.id, publicId: a.publicId })
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
  return row ?? null;
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
