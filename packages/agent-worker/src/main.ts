/**
 * Process entrypoint for the durable-run worker (agent-engine v2 —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * This file wires OS signals to `createAgentWorker(...).stop()`, reads
 * process configuration from the environment, and wires the real `RunStore`
 * (`@oxagen/agent-runner`'s `createPostgresRunStore`) and `TurnDriver`
 * (`@oxagen/agent`'s `createPlatformTurnDriver`, which reaches the engine via
 * `executeTurn`).
 *
 * This is the ONLY file in this package that imports either of those two
 * packages. `./worker.ts`, `./types.ts`, and the rest of this package's
 * internals stay dependency-pure (structural `RunStore`/`TurnDriver` ports
 * only) — see `./types.ts`'s module doc. Keep it that way: a future test or
 * bespoke wiring script should still be able to import `createAgentWorker`
 * directly with its own fakes, without pulling in Postgres or the engine.
 *
 * Env vars (registered in `packages/config/src/registry.ts` ENV_REGISTRY;
 * `.env.example` regenerated via `pnpm env:check --write`):
 *   OXAGEN_WORKER_CONCURRENCY — simultaneous runs this process drives (default 2).
 *   OXAGEN_WORKER_ID          — claim/lease owner identity (default `${hostname}:${pid}`).
 *
 * V2 fenced-attempt claims are deliberately NOT wired here. `createAgentWorker`
 * grows a `attempts` option (store + attempt driver + resolved engine identity)
 * that turns the V2 queue on; omitting it is the gate. Enabling V2 execution
 * before PR 2B deploys finalization consumption would mint one-shot
 * finalization grants and durable obligations that no running worker can
 * satisfy — so this process claims only already-enqueued V1 work, which
 * `createPostgresRunStore().claimNextRun(workerId)` (no engine options) is
 * exactly what does. PR 1B flips it on behind `OXAGEN_RUN_V2_CLAIMS_ENABLED`.
 */
import {
  createPostgresRunStore,
  shutdownStellaEngine,
} from "@oxagen/agent-runner";
import { createPlatformTurnDriver } from "@oxagen/agent";
import { createAgentWorker } from "./worker";
import { bootstrap } from "./bootstrap";
import type { AttemptRunStore, RunStore } from "./types";

function readConcurrency(): number | undefined {
  const raw = process.env.OXAGEN_WORKER_CONCURRENCY;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  // Kernel wiring MUST precede the first claim: handler registration + the
  // IAM/billing/entitlement gate injection + engram backends + the security
  // audit emitter (see ./bootstrap.ts). Without it, every capability tool the
  // driver materializes resolves to `no_handler` and the kernel's gates are
  // inert. Fail fast on boot errors — a worker that cannot enforce must not
  // claim runs.
  await bootstrap();

  // Widening the concrete store to BOTH structural ports is the drift check.
  // `./types.ts` hand-mirrors @oxagen/agent-runner's V2 surface so the harness
  // stays testable with plain fakes; this line is the one place the mirror is
  // compared against the real thing, so a divergence fails typecheck here
  // instead of surfacing in PR 1B the moment V2 claims are switched on.
  const store: RunStore & AttemptRunStore = createPostgresRunStore();
  const driveTurn = createPlatformTurnDriver();

  const worker = createAgentWorker({
    store,
    driveTurn,
    workerId: process.env.OXAGEN_WORKER_ID,
    concurrency: readConcurrency(),
    // Non-fatal failures the harness swallows by contract — a missed lease
    // renewal, a rolled-back append, a seal that could not be written. Without
    // a sink they vanish, and a silently unsealed attempt looks identical to a
    // healthy one until the reclaimer picks it up minutes later.
    onError: (err, ctx) => {
      console.error(
        `@oxagen/agent-worker: ${ctx.phase} failed${ctx.runId ? ` for run ${ctx.runId}` : ""}`,
        err,
      );
    },
  });

  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `@oxagen/agent-worker: ${signal} received, draining in-flight runs...`,
    );
    worker
      .stop()
      // Runs AFTER the drain, not beside it: an in-flight turn on the Stella
      // engine is mid-conversation with a sidecar, and killing the engine out
      // from under it would abort the very run the drain exists to finish.
      // A no-op on a worker that never ran a Stella turn.
      .then(() => shutdownStellaEngine())
      .then(() => {
        console.log("@oxagen/agent-worker: drained, exiting.");
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("@oxagen/agent-worker: error during shutdown", err);
        process.exit(1);
      });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  worker.start();
}

main().catch((err: unknown) => {
  console.error("@oxagen/agent-worker: bootstrap failed, exiting.", err);
  process.exit(1);
});
