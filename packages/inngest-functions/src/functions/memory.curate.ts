import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { MEMORY_CURATE_REQUESTED_EVENT } from "../events";
import { listDedicatedPlaneScopes } from "../lib/assistant-run-abandon";
import { logger } from "../logger";
import { memoryRunner } from "../lib/memory-runner";

type CurateRequest = { orgId: string; workspaceId: string };

function requestOf(data: unknown): CurateRequest | null {
  const d = data as Partial<CurateRequest> | null;
  return typeof d?.orgId === "string" &&
    d.orgId.length > 0 &&
    typeof d.workspaceId === "string" &&
    d.workspaceId.length > 0
    ? { orgId: d.orgId, workspaceId: d.workspaceId }
    : null;
}

/**
 * The curator for one workspace (ADR-206). It settles each open memory PR,
 * proposes retiring stale or contradicted records, and opens the day's memory
 * PR from the waiting memories.
 *
 * `run.reflect` asks for a pass when 20 memories are waiting, and the daily
 * job below asks once a day. Deliveries for one workspace are debounced and
 * never run two at once, so a burst of sealed runs opens one PR. A workspace
 * with no steering repo or no `steering/governance.toml` is left alone, and
 * its memories keep waiting.
 */
export const [memoryCurate] = createFunction(
  {
    id: "memory.curate",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.workspaceId" },
    debounce: {
      period: "1m",
      key: "event.data.workspaceId",
      timeout: "10m",
    },
  },
  { event: MEMORY_CURATE_REQUESTED_EVENT },
  async ({ event, step }) => {
    const request = requestOf(event.data);
    if (request === null)
      throw new NonRetriableError(
        "memory/curate.requested carries no orgId and workspaceId",
      );
    const result = await step.run("curate", () =>
      memoryRunner().curate(request, new Date()),
    );
    logger.info(
      {
        workspaceId: request.workspaceId,
        outcome: result.outcome,
        settled: result.settled,
        dropped: result.dropped,
        pullRequest: result.pullRequest?.number ?? null,
      },
      "memory.curate: pass complete",
    );
    return result;
  },
);

/**
 * Once a day, a curate pass for every workspace with memory work: waiting
 * memories, an open memory PR, or a merged record whose stale clock runs. An
 * organization on a dedicated Postgres plane (ADR-042) keeps its memories
 * there, out of the shared read, so each of its workspaces is asked, and one
 * with nothing to do answers `idle`.
 */
export const [memoryCurateDaily] = createFunction(
  { id: "memory.curate-daily", retries: 1, concurrency: { limit: 1 } },
  { cron: "17 6 * * *" },
  async ({ step }) => {
    const scopes = await step.run("list-memory-workspaces", async () => {
      const [shared, dedicated] = await Promise.all([
        memoryRunner().workspaces(),
        listDedicatedPlaneScopes(),
      ]);
      const all = new Map<string, CurateRequest>();
      for (const s of [...shared, ...dedicated])
        all.set(s.workspaceId, {
          orgId: s.orgId,
          workspaceId: s.workspaceId,
        });
      return [...all.values()];
    });
    if (scopes.length === 0) return { requested: 0 };
    await step.sendEvent(
      "request-curates",
      scopes.map((s) => ({
        name: MEMORY_CURATE_REQUESTED_EVENT,
        data: { ...s, reason: "daily" },
      })),
    );
    return { requested: scopes.length };
  },
);
