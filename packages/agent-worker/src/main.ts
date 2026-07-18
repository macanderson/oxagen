/**
 * Process entrypoint for the durable-run worker (agent-engine v2 Phase 2c —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * This file wires OS signals to `createAgentWorker(...).stop()`, reads
 * process configuration from the environment, AND — as of the integration PR
 * that follows Phase 2a (Postgres schema)/Phase 2b (`createPostgresRunStore`)
 * — wires the real `RunStore` (`@oxagen/agent-runner`) and `TurnDriver`
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
 */
import { createPostgresRunStore } from "@oxagen/agent-runner";
import { createPlatformTurnDriver } from "@oxagen/agent";
import { createAgentWorker } from "./worker";

function readConcurrency(): number | undefined {
  const raw = process.env.OXAGEN_WORKER_CONCURRENCY;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function main(): void {
  const store = createPostgresRunStore();
  const driveTurn = createPlatformTurnDriver();

  const worker = createAgentWorker({
    store,
    driveTurn,
    workerId: process.env.OXAGEN_WORKER_ID,
    concurrency: readConcurrency(),
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

main();
