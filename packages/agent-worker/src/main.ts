/**
 * Process entrypoint for the durable-run worker (agent-engine v2 Phase 2c —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * This file wires OS signals to `createAgentWorker(...).stop()` and reads
 * process configuration from the environment — but it does NOT wire a real
 * `RunStore` or `TurnDriver`. Those land in the integration PR that follows
 * Phase 2a (Postgres schema, `agent_runs`/`agent_events`) and Phase 2b
 * (`createPostgresRunStore`), once `executeTurn`'s engine-facing shape is
 * settled (`packages/agent-runner`). Running this file today exits
 * immediately with a clear message instead of a stack trace — the package
 * itself (`createAgentWorker`) is fully usable standalone in the meantime by
 * importing it directly with your own store + driver (e.g. from tests, or a
 * bespoke wiring script).
 *
 * Env vars (registered in `packages/config/src/registry.ts` ENV_REGISTRY;
 * `.env.example` regenerated via `pnpm env:check --write`):
 *   OXAGEN_WORKER_CONCURRENCY — simultaneous runs this process drives (default 2).
 *   OXAGEN_WORKER_ID          — claim/lease owner identity (default `${hostname}:${pid}`).
 */
import { createAgentWorker } from "./worker";
import type { RunStore, TurnDriver } from "./types";

function readConcurrency(): number | undefined {
  const raw = process.env.OXAGEN_WORKER_CONCURRENCY;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function main(): void {
  // TODO(agent-engine-v2 integration PR): wire the real RunStore
  // (createPostgresRunStore, Phase 2b) and TurnDriver (executeTurn) here once
  // both land. Left undefined on purpose until then — see the module doc.
  const store: RunStore | undefined = undefined;
  const driveTurn: TurnDriver | undefined = undefined;

  if (!store || !driveTurn) {
    console.error(
      "@oxagen/agent-worker: no RunStore/TurnDriver wired yet. This bin entrypoint is a " +
        "placeholder for the agent-engine v2 Phase 2c → integration PR handoff " +
        "(docs/specs/agent-engine-v2/plan.md). Import createAgentWorker from " +
        "@oxagen/agent-worker directly with your own store + driver until then.",
    );
    process.exit(1);
  }

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
