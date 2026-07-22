import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  createPostgresRunStore,
  buildLegacyRunSpecV1,
  type AttemptEventReadRecord,
  type AttemptRunStore,
  type RunSummary,
  type RunStore,
} from "@oxagen/agent-runner";
import { runInTenantScope } from "@oxagen/tenancy";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Durable-run API (agent-engine v2 Phase 2 integration;
 * docs/specs/agent-engine-v2/spec.md §4.2, plan.md Phase 2 — "SSE is a
 * replayable subscription from last seq"; run-evidence-ingress
 * 02-run-attempt-foundation-plan.md Task 6 for the v1/v2 split below).
 *
 * ## Two gates, deliberately not one
 *
 * - **OXAGEN_DURABLE_RUNS** mounts the ROUTER. Off ⇒ every route below 404s.
 * - **OXAGEN_V1_RUN_ADMISSION_ENABLED** gates the POST METHOD only. Off ⇒
 *   `POST /runs` refuses to admit new legacy v1 work while GET status,
 *   resumable SSE, and cancel keep serving every historical row.
 *
 * Collapsing them into one flag is exactly the mistake Task 6 exists to
 * avoid: turning off new v1 writes must never remove historical reads or make
 * already-queued rows unclaimable. The worker's claim path is separate again
 * (`claimLegacyV1`), so a closed admission gate drains the queue rather than
 * stranding it.
 *
 * Both flags are read PER REQUEST (never at module load — importing this file,
 * or app.ts, must never require env access; same discipline as app.ts's
 * lazy rate-limit budget resolvers).
 *
 * ## v1 vs v2 reads
 *
 * A run row carries `spec_version`, surfaced on `RunSummary.specVersion`, and
 * the two record versions have INCOMPATIBLE cursors: v1 events are ordered by
 * a run-global `seq` integer, v2 events by a `run_seq` bigint carried as an
 * exact decimal string. The SSE route branches on that discriminant rather
 * than guessing, and each branch parses `?after=` with its own cursor grammar.
 *
 * ## What this route does NOT do
 *
 * It admits v1 ONLY. Trusted v2 admission (`enqueueRunV2`) requires a
 * server-resolved actor binding, a pinned authorization snapshot, and a
 * retention-policy version — none of which may come from a request body — so
 * it is not a matter of widening this handler's schema. That admission surface
 * lands with its own capability contract; until then this route's spec is
 * built by `buildLegacyRunSpecV1` from @oxagen/agent-runner, the single
 * definition the worker's claim-side parser also uses.
 *
 * These routes do NOT go through invoke()/the capability kernel — they are a
 * thin adapter over @oxagen/agent-runner's RunStore (the ONLY writer/reader
 * of agent.agent_runs / agent.agent_run_events), calling withTenantDb-backed
 * methods inside an explicit runInTenantScope the same way chat.stream.ts
 * and connection.ts's /:id/resync do (this route calls withTenantDb-backed
 * store methods directly, so it must open the ALS scope itself).
 *
 * POST /runs enqueues a run and returns immediately (202) — the durable
 * worker that claims and executes the run is separate wiring (Phase 2c);
 * this slice is enqueue + status + resumable SSE + cancel-request only.
 */

const ToolPolicySchema = z
  .object({
    allowlist: z.array(z.string().min(1)).optional(),
    riskCeiling: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

const CreateRunBodySchema = z
  .object({
    // Same ingress cap as the chat surfaces (CHAT_CONTENT_MAX_CHARS) so every
    // entrypoint into the engine rejects an oversized instruction identically.
    instruction: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
    model: z.string().min(1).optional(),
    toolPolicy: ToolPolicySchema.optional(),
  })
  .strict();

const TERMINAL_RUN_STATUSES: ReadonlySet<RunSummary["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// ── SSE poll/heartbeat cadence — test-overridable ───────────────────────────
//
// Production defaults per spec: poll-tail every ~750ms, heartbeat comment
// every ~15s while idle. Route tests inject a much shorter cadence via the
// setters below so a scripted terminal run drains in milliseconds of real
// time instead of blocking on real timers; never call these from production
// code.
export const DEFAULT_RUN_SSE_POLL_INTERVAL_MS = 750;
export const DEFAULT_RUN_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

let ssePollIntervalMs = DEFAULT_RUN_SSE_POLL_INTERVAL_MS;
let sseHeartbeatIntervalMs = DEFAULT_RUN_SSE_HEARTBEAT_INTERVAL_MS;

/** Test-only: shorten the SSE poll/heartbeat cadence. Never call in production code. */
export function setRunSseTimingForTests(overrides: {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}): void {
  if (overrides.pollIntervalMs !== undefined) {
    ssePollIntervalMs = overrides.pollIntervalMs;
  }
  if (overrides.heartbeatIntervalMs !== undefined) {
    sseHeartbeatIntervalMs = overrides.heartbeatIntervalMs;
  }
}

/** Test-only: restore default SSE timing after a test overrides it. */
export function resetRunSseTimingForTests(): void {
  ssePollIntervalMs = DEFAULT_RUN_SSE_POLL_INTERVAL_MS;
  sseHeartbeatIntervalMs = DEFAULT_RUN_SSE_HEARTBEAT_INTERVAL_MS;
}

/** One SSE frame, already reduced to the three fields the wire carries. */
interface SseEmission {
  /** The `id:` field — this run's cursor, always decimal text. */
  id: string;
  /** The `event:` field — the event's type. */
  event: string;
  /** The `data:` field, JSON-encoded at write time. */
  data: unknown;
}

/**
 * Project one v2 attempt event into an SSE frame.
 *
 * Deliberately NOT a pass-through of the read record. Two fields on it are
 * INTERNAL UUIDs (`eventId`, `attemptId`) and internal ids never cross a
 * tenant-facing boundary — the attempt is cited by its `arat_` public id
 * instead. Everything else is the receipt a subscriber needs to verify the
 * event independently: its digests, its stage, and either the allow-listed
 * inline payload or the reference to the encrypted blob that holds the real
 * body.
 */
function projectAttemptEvent(evt: AttemptEventReadRecord): SseEmission {
  return {
    id: evt.runSeq,
    event: evt.eventType,
    data: {
      attemptId: evt.attemptPublicId,
      attemptSeq: evt.attemptSeq,
      runSeq: evt.runSeq,
      eventSchemaVersion: evt.eventSchemaVersion,
      stage: evt.stage,
      payloadDigest: evt.payloadDigest,
      eventDigest: evt.eventDigest,
      payload: evt.payload,
      encryptedPayloadRef: evt.encryptedPayloadRef,
      observedAt: evt.observedAt,
    },
  };
}

/** Resolve ms then early-resolve on abort; unref()s the timer where the runtime supports it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Node timers support unref() (don't keep the process alive for a
    // background poll); Edge/browser timers don't have it — guard the call.
    const unrefable = timer as unknown as { unref?: () => void };
    if (typeof unrefable.unref === "function") unrefable.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function durableRunsEnabled(): boolean {
  const v = process.env.OXAGEN_DURABLE_RUNS;
  return v === "1" || v === "true";
}

/**
 * Legacy v1 ADMISSION gate (POST only). Defaults to ON when unset: PR 1A
 * ships the dual reader while queued v1 work is still draining, and closing
 * admission is PR 1B's cutover step, not this one's. Only an explicit
 * "0"/"false" closes it — an unset or malformed value must not silently stop
 * a surface that is still the platform's only durable-run entrypoint.
 */
function v1RunAdmissionEnabled(): boolean {
  const v = process.env.OXAGEN_V1_RUN_ADMISSION_ENABLED;
  return v !== "0" && v !== "false";
}

// Lazily constructed so importing this module never touches the DB — the
// store's methods are pure closures over withTenantDb/withSystemDb.
//
// Typed as BOTH ports: the v2 read path (`readAttemptEventsSince`) lives on
// `AttemptRunStore`, and widening here is what makes a drift between the two
// interfaces fail typecheck in this file rather than at runtime on the first
// v2 subscription.
const runStore: RunStore & AttemptRunStore = createPostgresRunStore();

export const agentRunRoute = new Hono<AppEnv>();

// Kill switch: every route below 404s unless OXAGEN_DURABLE_RUNS is "1"/
// "true". Checked per-request (see module comment) so tests can flip the env
// var between requests without reloading the module.
agentRunRoute.use("*", async (c, next) => {
  if (!durableRunsEnabled()) {
    throw new HTTPException(404, { message: "Not found" });
  }
  await next();
});

// POST /runs — enqueue a durable run. 202 { runId: <publicId>, status: "pending" }.
//
// 403 (not 404) when v1 admission is closed: the router IS mounted and every
// other method on this path still works, so a 404 would misreport the resource
// as absent and send a client hunting for a routing bug instead of reading the
// error.
agentRunRoute.post("/", async (c) => {
  if (!v1RunAdmissionEnabled()) {
    throw new HTTPException(403, {
      message:
        "Legacy RunSpec v1 admission is disabled. Existing runs remain " +
        "readable and cancellable, and already-queued work still executes.",
    });
  }
  const body = CreateRunBodySchema.parse(await c.req.json());
  const ctx = capabilityContext(c);

  const spec = buildLegacyRunSpecV1({
    instruction: body.instruction,
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.toolPolicy !== undefined ? { toolPolicy: body.toolPolicy } : {}),
  });

  const { publicId } = await runInTenantScope(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    () =>
      runStore.enqueueRun({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "api-chat",
        spec,
      }),
  );

  return c.json({ runId: publicId, status: "pending" }, 202);
});

// GET /runs/:publicId — 200 RunSummary, 404 unknown/cross-tenant.
agentRunRoute.get("/:publicId", async (c) => {
  const publicId = c.req.param("publicId");
  const ctx = capabilityContext(c);

  const run = await runInTenantScope(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    () => runStore.getRunByPublicId(publicId),
  );
  if (!run) {
    throw new HTTPException(404, { message: `Run not found: ${publicId}` });
  }
  return c.json(run, 200);
});

// GET /runs/:publicId/events?after=<cursor> — resumable SSE subscription.
//
// Replays the run's event log from `after` (default 0) with SSE `id:` = the
// cursor and `event:` = the event's type, then poll-tails new events until the
// run reaches a terminal status, at which point it emits `event: done` with
// the terminal RunSummary and closes. Reconnecting with `?after=<last id>`
// loses zero events (plan.md Phase 2 exit criterion).
//
// The cursor's MEANING depends on the run's record version: `seq` for v1,
// `run_seq` for v2. Its GRAMMAR is shared — a non-negative decimal integer —
// and it is carried as a STRING end to end, because `run_seq` is a Postgres
// bigint and routing it through a JS number would silently corrupt any cursor
// past 2^53 and resume a subscriber at the wrong event.
const AfterQuerySchema = z
  .string()
  .regex(/^\d+$/, "after must be a non-negative decimal integer")
  .max(19, "after exceeds the bigint range");

agentRunRoute.get("/:publicId/events", async (c) => {
  const publicId = c.req.param("publicId");
  const afterRaw = c.req.query("after");
  const after = afterRaw === undefined ? "0" : AfterQuerySchema.parse(afterRaw);
  const ctx = capabilityContext(c);
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const run = await runInTenantScope(scope, () =>
    runStore.getRunByPublicId(publicId),
  );
  if (!run) {
    throw new HTTPException(404, { message: `Run not found: ${publicId}` });
  }

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = signal.aborted;
      const onAbort = () => {
        closed = true;
      };
      signal.addEventListener("abort", onAbort);

      function write(chunk: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client disconnected — the controller is closed; latch so later
          // writes in this tick are no-ops instead of throwing.
          closed = true;
        }
      }

      function emitEvent(evt: SseEmission): void {
        write(
          `id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`,
        );
      }

      // One page of the log in this run's own record version. Both readers are
      // page-capped (DEFAULT_READ_EVENTS_LIMIT rows), so the caller loops.
      const runId = run.runId;
      const isV2 = run.specVersion === 2;
      async function readPage(cursor: string): Promise<SseEmission[]> {
        if (isV2) {
          const rows = await runInTenantScope(scope, () =>
            runStore.readAttemptEventsSince(runId, cursor),
          );
          return rows.map(projectAttemptEvent);
        }
        const rows = await runInTenantScope(scope, () =>
          runStore.readEventsSince(runId, Number(cursor)),
        );
        return rows.map((evt) => ({
          id: String(evt.seq),
          event: evt.type,
          data: evt.payload,
        }));
      }

      // Drain every event after `fromCursor`, emitting each and returning the
      // new last-seen cursor. One read only sees the whole backlog when it
      // fits in a page — a long turn's text-delta stream can easily exceed
      // that. Loop until a read comes back empty (each call advances the
      // cursor) so replay/drain never silently truncate.
      async function drainSince(fromCursor: string): Promise<string> {
        let cursor = fromCursor;
        while (!closed) {
          const page = await readPage(cursor);
          if (page.length === 0) break;
          for (const evt of page) {
            emitEvent(evt);
            cursor = evt.id;
          }
        }
        return cursor;
      }

      try {
        let lastCursor = await drainSince(after);

        let status = run.status;
        let finalSummary: RunSummary | null = TERMINAL_RUN_STATUSES.has(status)
          ? run
          : null;
        let lastActivityAt = Date.now();

        while (!closed && !TERMINAL_RUN_STATUSES.has(status)) {
          await sleep(ssePollIntervalMs, signal);
          if (closed) break;

          const beforeCursor = lastCursor;
          lastCursor = await drainSince(lastCursor);
          // String inequality, not `>`: the cursor is decimal text and a
          // lexicographic compare would call "10" older than "9". A drain only
          // ever moves the cursor forward, so "changed" IS "advanced".
          if (lastCursor !== beforeCursor) lastActivityAt = Date.now();

          const latest = await runInTenantScope(scope, () =>
            runStore.getRunByPublicId(publicId),
          );
          if (!latest) break; // Deleted mid-stream — treat as end of subscription.
          status = latest.status;
          if (TERMINAL_RUN_STATUSES.has(status)) finalSummary = latest;

          if (
            !closed &&
            Date.now() - lastActivityAt >= sseHeartbeatIntervalMs
          ) {
            write(": heartbeat\n\n");
            lastActivityAt = Date.now();
          }
        }

        if (!closed && finalSummary) {
          // Final drain: observing a terminal status only guarantees
          // completeRun/failRun/cancelRun already committed — it does NOT
          // guarantee this stream already saw every event committed
          // alongside it (the run's final result event can land in the same
          // tick status flips terminal). One more read, taken strictly after
          // the terminal observation, is guaranteed to see everything —
          // nothing is appended to agent_run_events after a terminal write.
          // `drainSince` loops until a read returns empty, so a terminal run
          // with a >1-page backlog is fully emitted before `done` closes the
          // stream (the client won't reconnect once it sees `done`).
          lastCursor = await drainSince(lastCursor);
          write(`event: done\ndata: ${JSON.stringify(finalSummary)}\n\n`);
        }
      } catch (err) {
        if (!closed) {
          const message = err instanceof Error ? err.message : "Stream error";
          write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

// POST /runs/:publicId/cancel — request cooperative cancellation. The worker
// observes cancel_requested and drops the run future (spec.md §4.2); this
// route never blocks waiting for that to happen.
agentRunRoute.post("/:publicId/cancel", async (c) => {
  const publicId = c.req.param("publicId");
  const ctx = capabilityContext(c);
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const run = await runInTenantScope(scope, () =>
    runStore.getRunByPublicId(publicId),
  );
  if (!run) {
    throw new HTTPException(404, { message: `Run not found: ${publicId}` });
  }

  await runInTenantScope(scope, () => runStore.requestCancel(run.runId));

  return c.json({ status: "cancelling" }, 202);
});
