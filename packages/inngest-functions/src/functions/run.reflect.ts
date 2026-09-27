import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { MEMORY_CURATE_REQUESTED_EVENT } from "../events";
import { logger } from "../logger";
import { MEMORY_CURATE_WAITING, memoryRunner } from "../lib/memory-runner";

type RunReflectRequest = { orgId: string; workspaceId: string; runId: string };

function requestOf(data: unknown): RunReflectRequest | null {
  const d = data as Partial<RunReflectRequest> | null;
  return typeof d?.orgId === "string" &&
    typeof d.workspaceId === "string" &&
    typeof d.runId === "string" &&
    d.runId.length > 0
    ? { orgId: d.orgId, workspaceId: d.workspaceId, runId: d.runId }
    : null;
}

/**
 * `cost/run.sealed` → store the memories and the reflection the run recorded
 * (ADR-206).
 *
 * Capture reads each `remember_lesson` and `record_reflection` call from the
 * run's frames and stores it with the agent and run the record names. A
 * wrapped run that shows a signal and holds no reflection then gets one from
 * its digest on the fast tier. When the workspace has 20 or more memories
 * waiting, the job asks the curator to run before its daily pass.
 *
 * Concurrency is one per run, so two seals of one run cannot race the rows. A
 * reseal captures again, and the dedupe key writes no memory twice. A run no
 * store holds is dropped without a retry, and a degraded store throws for
 * Inngest to retry.
 */
export const [runReflect] = createFunction(
  {
    id: "run.reflect",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.runId" },
  },
  { event: "cost/run.sealed" },
  async ({ event, step }) => {
    const request = requestOf(event.data);
    if (request === null)
      throw new NonRetriableError(
        "cost/run.sealed carries no orgId, workspaceId and runId",
      );
    const scope = { orgId: request.orgId, workspaceId: request.workspaceId };

    const captured = await step.run("capture", () =>
      memoryRunner().capture(scope, request.runId),
    );
    if (captured.outcome !== "captured") {
      logger.info(
        { runId: request.runId, outcome: captured.outcome },
        "run.reflect: run not read",
      );
      return { runId: request.runId, outcome: captured.outcome };
    }

    const digest = captured.digest
      ? await step.run("digest", () =>
          memoryRunner().digest(scope, request.runId),
        )
      : null;

    const curate = captured.waiting >= MEMORY_CURATE_WAITING;
    if (curate)
      await step.sendEvent("request-curate", {
        name: MEMORY_CURATE_REQUESTED_EVENT,
        data: { ...scope, reason: "waiting" },
      });

    return {
      runId: request.runId,
      outcome: captured.outcome,
      memories: captured.memories,
      reflected: captured.reflected,
      digest,
      curate,
    };
  },
);
