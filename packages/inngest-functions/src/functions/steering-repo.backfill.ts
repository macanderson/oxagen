import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  listHeadlessWorkspaces,
  type HeadlessWorkspace,
} from "../lib/steering-repo-backfill";

/** Workspaces read per step. */
export const BACKFILL_PAGE_SIZE = 200;
/** Pages read per run. The next run starts again from the first page. */
export const BACKFILL_MAX_PAGES = 10;
/**
 * How long a queued workspace waits for its job's first step before this job
 * sends the event again. The provision job runs one workspace per
 * organization at a time, so a short wait is normal.
 */
export const QUEUED_GRACE_MS = 60 * 60 * 1000;

type WithActor = HeadlessWorkspace & { actorUserId: string };

const hasActor = (w: HeadlessWorkspace): w is WithActor =>
  w.actorUserId !== null;

/**
 * One page of headless workspaces after `after`. It logs the ids of any
 * workspace with no creator, because the job skips those.
 */
async function readPage(after: string | null): Promise<HeadlessWorkspace[]> {
  const found = await listHeadlessWorkspaces({
    after,
    queuedBefore: new Date(Date.now() - QUEUED_GRACE_MS),
    limit: BACKFILL_PAGE_SIZE,
  });
  const orphaned = found.filter((w) => !hasActor(w));
  if (orphaned.length > 0)
    logger.warn(
      { workspaceIds: orphaned.map((w) => w.workspaceId) },
      "steering_repo.backfill: skipped workspaces with no creator to record as the author",
    );
  return found;
}

/**
 * Start steering repo provisioning for each workspace that has no steering
 * head and never started it (#4683).
 *
 * A workspace created before ADR-212 has no steering repo, so it cannot link
 * a code repository, and nothing else provisions it. The same holds for a
 * workspace whose event failed to send or never ran. This job sends it the
 * same `steering-repo/provision.requested` event that `create_workspace`
 * sends a new one. Sending it twice is safe:
 *
 * - The event id names the workspace, so Inngest drops a repeat for 24 hours.
 * - The provision job's first step records a state, and the next run's read
 *   no longer selects a workspace that has one.
 * - Every provision step reads what earlier runs recorded, so a repeat
 *   finishes the work instead of doing it twice.
 */
export const [steeringRepoBackfill] = createFunction(
  {
    id: "steering-repo/headless-backfill",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    let after: string | null = null;
    let requested = 0;
    let skipped = 0;
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const cursor = after;
      const name = `list-headless-workspaces-${page}`;
      const rows = await step.run(name, () => readPage(cursor));
      const ready = rows.filter(hasActor);
      skipped += rows.length - ready.length;
      if (ready.length > 0) {
        await step.sendEvent(
          `request-provisioning-${page}`,
          ready.map((w) => ({
            name: "steering-repo/provision.requested",
            id: `steering-repo-backfill:${w.workspaceId}`,
            data: {
              orgId: w.orgId,
              workspaceId: w.workspaceId,
              actorUserId: w.actorUserId,
            },
          })),
        );
        requested += ready.length;
      }
      // Typed, so the cursor's type does not loop back through `rows`.
      const last: HeadlessWorkspace | undefined = rows.at(-1);
      if (last === undefined || rows.length < BACKFILL_PAGE_SIZE) break;
      after = last.workspaceId;
    }
    return { requested, skipped };
  },
);
