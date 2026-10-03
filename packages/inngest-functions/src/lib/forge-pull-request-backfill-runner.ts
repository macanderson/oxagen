// forge-pull-request-backfill-runner.ts: the seam between the scheduled forge
// backfill (functions/forge.pull-request-backfill.ts) and the code that finds
// the links to move (ADR-292).
//
// Links recorded before the forge store existed have no `forge.pull_requests`
// row: a run's `tacho.run_pull_requests` rows and a work order's `pr_linked`
// facts. The finder reads those tables and the forge tables through
// `@oxagen/handlers`, and `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers' register module installs the runner
// when the API process boots, before the Inngest route can invoke a function.
// `forge-pull-request-sync-runner.ts` is the same seam for the same reason.
import type { ForgePullRequestSyncRequest } from "./forge-pull-request-sync-runner";

/** The older stores a link can come from, in the order the backfill reads them. */
export const FORGE_BACKFILL_SOURCES = ["run_pull_requests", "pr_linked"] as const;
export type ForgeBackfillSource = (typeof FORGE_BACKFILL_SOURCES)[number];

/** One page of one source: the rows after `after`, by id, at most `limit`. */
export interface ForgeBackfillRequest {
  source: ForgeBackfillSource;
  /** The id of the last row the previous page read; null for the first page. */
  after: string | null;
  limit: number;
}

/** One `forge/pull-request.observed` event to send, less its name. */
export interface ForgeBackfillEvent {
  /** `forge-backfill:<workspace>:<provider>:<repository>#<number>[:<run or order>]` */
  id: string;
  data: ForgePullRequestSyncRequest;
}

/** What one page found. */
export interface ForgeBackfillPage {
  /** One event per link on the page whose pull request has no forge row. */
  events: ForgeBackfillEvent[];
  /** How many rows the page read, with a forge row or without. */
  read: number;
  /** The id of the page's last row, the next page's cursor; null when it read none. */
  last: string | null;
}

export type ForgeBackfillRunner = (
  request: ForgeBackfillRequest,
) => Promise<ForgeBackfillPage>;

let runner: ForgeBackfillRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setForgeBackfillRunner(next: ForgeBackfillRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function forgeBackfillRunner(): ForgeBackfillRunner {
  if (!runner)
    throw new Error(
      "[forge.pull-request-backfill] no backfill runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
