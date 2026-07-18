import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  createPostgresRunStore,
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
 * replayable subscription from last seq").
 *
 * Flag-gated behind OXAGEN_DURABLE_RUNS ("1"/"true") — OFF by default, every
 * route below 404s until the var is set (packages/config/src/registry.ts).
 * The flag is read PER REQUEST (never at module load — importing this file,
 * or app.ts, must never require env access; same discipline as app.ts's
 * lazy rate-limit budget resolvers).
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
 *
 * RunSpec v1 — the exact spec JSON persisted to agent_runs.spec and parsed by
 * the worker's driver on the other side. Do not add/rename/reshape fields
 * here without updating the driver in lockstep.
 */
interface RunSpecV1 {
  version: 1;
  instruction: string;
  model?: string;
  history?: unknown;
  toolPolicy?: {
    allowlist?: string[];
    riskCeiling?: "low" | "medium" | "high";
  };
}

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

// Lazily constructed so importing this module never touches the DB — the
// store's methods are pure closures over withTenantDb/withSystemDb.
const runStore: RunStore = createPostgresRunStore();

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
agentRunRoute.post("/", async (c) => {
  const body = CreateRunBodySchema.parse(await c.req.json());
  const ctx = capabilityContext(c);

  const spec: RunSpecV1 = {
    version: 1,
    instruction: body.instruction,
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.toolPolicy !== undefined ? { toolPolicy: body.toolPolicy } : {}),
  };

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

// GET /runs/:publicId/events?after=<seq> — resumable SSE subscription.
//
// Replays agent_run_events from `after` (default 0) with SSE `id:` = seq and
// `event:` = the event's type, then poll-tails new events until the run
// reaches a terminal status, at which point it emits `event: done` with the
// terminal RunSummary and closes. Reconnecting with `?after=<last id>` loses
// zero events (plan.md Phase 2 exit criterion).
const AfterQuerySchema = z.coerce.number().int().min(0);

agentRunRoute.get("/:publicId/events", async (c) => {
  const publicId = c.req.param("publicId");
  const afterRaw = c.req.query("after");
  const after = afterRaw === undefined ? 0 : AfterQuerySchema.parse(afterRaw);
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

      function emitEvent(evt: {
        seq: number;
        type: string;
        payload: unknown;
      }): void {
        write(
          `id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`,
        );
      }

      // Drain every event after `fromSeq`, emitting each and returning the
      // new last-seen seq. A single `readEventsSince` is page-capped
      // (DEFAULT_READ_EVENTS_LIMIT rows), so one read only sees the whole
      // backlog when it fits in a page — a long turn's text-delta stream can
      // easily exceed that. Loop until a read comes back empty (each call
      // advances the cursor) so replay/drain never silently truncate.
      const runId = run.runId;
      async function drainSince(fromSeq: number): Promise<number> {
        let seq = fromSeq;
        while (!closed) {
          const batch = await runInTenantScope(scope, () =>
            runStore.readEventsSince(runId, seq),
          );
          if (batch.length === 0) break;
          for (const evt of batch) {
            emitEvent(evt);
            seq = evt.seq;
          }
        }
        return seq;
      }

      try {
        let lastSeq = await drainSince(after);

        let status = run.status;
        let finalSummary: RunSummary | null = TERMINAL_RUN_STATUSES.has(status)
          ? run
          : null;
        let lastActivityAt = Date.now();

        while (!closed && !TERMINAL_RUN_STATUSES.has(status)) {
          await sleep(ssePollIntervalMs, signal);
          if (closed) break;

          const beforeSeq = lastSeq;
          lastSeq = await drainSince(lastSeq);
          if (lastSeq > beforeSeq) lastActivityAt = Date.now();

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
          lastSeq = await drainSince(lastSeq);
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
