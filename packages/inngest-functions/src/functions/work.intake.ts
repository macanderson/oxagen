// work.intake.ts: the durable jobs that bring work in and triage it (lane
// P1-03, #5103; agent-work-phase-1.html, Work lifecycle and Delivery and
// review).
//
// - work/intake-collect: a stored webhook delivery names items. Fetch each one
//   from the provider, one step per item, and store it. Oxagen maps what it
//   fetched, never the webhook body.
// - work/intake-sweep and work/intake-count-sweep: every 15 minutes, and once
//   a night, ask for one check per collector that is not paused.
// - work/intake-check: one collector's reconcile or nightly count. A reconcile
//   reads page by page, one step per page, and the cursor moves only after a
//   page is stored. One check runs at a time per collector. A collector whose
//   repositories are all unlinked records a failed read that says so.
// - work/intake-triage: draft one triage suggestion. At most 60 start per
//   workspace per minute (TRIAGE_DECISIONS_PER_MINUTE in @oxagen/work), and
//   the rest wait in the queue. When the retries run out, the on-failure
//   companion records the failure on the item, so it stays visible. The
//   event carries the item revision it is about, so a late failure does not
//   land on a newer revision or after a result.
// - work/intake-prune: once a day, delete stored deliveries and result rows
//   past the retention window.
//
// Every write goes through the runner (lib/work-intake-runner.ts), which
// @oxagen/handlers installs at boot.
import { NonRetriableError, type StepContext } from "@oxagen/functions";
import { createFunction } from "../create-function";
import {
  type WorkIntakeChange,
  type WorkIntakeScope,
  type WorkReconcileSummary,
  type WorkTriageFailedRun,
  workIntakeRunner,
} from "../lib/work-intake-runner";

/** The most reconcile pages one check reads. The next check resumes from the cursor. */
export const RECONCILE_MAX_PAGES = 20;

/** The most triage runs that start per workspace per minute. Matches TRIAGE_DECISIONS_PER_MINUTE in @oxagen/work. */
export const TRIAGE_RUNS_PER_MINUTE = 60;

/**
 * The result a check records when the workspace links none of the collector's
 * repositories. The read is skipped as `scope_invalid`, which no person can
 * see: the collector's last read would stop moving with no word why (#5254
 * dropped unlinked repositories from the scope). Recording it as a failed
 * read shows the reason under the collector, and three in a row turn it
 * failing, so it waits for a person to link a repository.
 */
export const NO_LINKED_REPOSITORIES_ERROR =
  "The workspace links none of the repositories this collector reads, so it read nothing. Link one on the Repositories page, or set the collector to read a linked repository.";

function text(data: Record<string, unknown>, key: string, job: string): string {
  const value = data[key];
  if (typeof value !== "string" || value === "") {
    throw new NonRetriableError(`${job}: the event has no ${key}, so there is nothing to act on.`);
  }
  return value;
}

function scopeOf(data: Record<string, unknown>, job: string): WorkIntakeScope {
  return { orgId: text(data, "org_id", job), workspaceId: text(data, "workspace_id", job) };
}

/**
 * One work/item.received event per change. The id dedupes a repeat of the
 * same change, so the revision stays out of it. The data carries the revision
 * when the change knows it.
 */
export function itemReceivedEvents(scope: WorkIntakeScope, changes: readonly WorkIntakeChange[]) {
  return changes.map((change) => ({
    name: "work/item.received",
    id: `work-item-${change.publicId}-${change.change}-${change.digest}`,
    data: {
      org_id: scope.orgId,
      workspace_id: scope.workspaceId,
      item_id: change.publicId,
      change: change.change,
      ...(change.revision === undefined ? {} : { revision: change.revision }),
    },
  }));
}

export const [workIntakeCollect] = createFunction(
  {
    id: "work/intake-collect",
    retries: 4,
    concurrency: { limit: 5, key: "event.data.workspace_id" },
  },
  { event: "work/event.received" },
  async ({ event, step }) => {
    const job = "work/intake-collect";
    const scope = scopeOf(event.data, job);
    const inboundEventId = text(event.data, "inbound_event_id", job);
    const opened = await step.run("open", () => workIntakeRunner().openDelivery(scope, inboundEventId));
    if (opened.kind !== "ready") return { collected: 0, skipped: opened.reason };
    const changes: WorkIntakeChange[] = [];
    for (const [index, ref] of opened.refs.entries()) {
      const change = await step.run(`collect-${index}`, () =>
        workIntakeRunner().collectRef(scope, opened.collectorId, ref),
      );
      if (change !== null) changes.push(change);
    }
    await step.run("close", () => workIntakeRunner().closeDelivery(scope, inboundEventId));
    if (changes.length > 0) await step.sendEvent("item-received", itemReceivedEvents(scope, changes));
    return { collected: opened.refs.length, changed: changes.length };
  },
);

/** Ask for one check per collector that is not paused. */
async function requestChecks(
  step: StepContext,
  check: "reconcile" | "count",
  stamp: string,
): Promise<number> {
  const targets = await step.run("list-collectors", () => workIntakeRunner().collectorTargets());
  if (targets.length === 0) return 0;
  await step.sendEvent(
    "request-checks",
    targets.map((target) => ({
      name: "work/collector.check.requested",
      id: `work-check-${check}-${target.collectorId}-${stamp}`,
      data: {
        org_id: target.orgId,
        workspace_id: target.workspaceId,
        collector_id: target.collectorId,
        check,
        force: false,
      },
    })),
  );
  return targets.length;
}

/** The minute a sweep runs, as the dedupe stamp of the checks it asks for. */
function minuteStamp(now: Date): string {
  return now.toISOString().slice(0, 16);
}

export const [workIntakeSweep] = createFunction(
  { id: "work/intake-sweep", retries: 1, concurrency: { limit: 1 } },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const stamp = await step.run("stamp", () => Promise.resolve(minuteStamp(new Date())));
    return { requested: await requestChecks(step, "reconcile", stamp) };
  },
);

export const [workIntakeCountSweep] = createFunction(
  { id: "work/intake-count-sweep", retries: 1, concurrency: { limit: 1 } },
  { cron: "23 3 * * *" },
  async ({ step }) => {
    const stamp = await step.run("stamp", () => Promise.resolve(minuteStamp(new Date())));
    return { requested: await requestChecks(step, "count", stamp) };
  },
);

export const [workIntakeCheck] = createFunction(
  {
    id: "work/intake-check",
    retries: 2,
    concurrency: { limit: 1, key: "event.data.collector_id" },
  },
  { event: "work/collector.check.requested" },
  async ({ event, step }) => {
    const job = "work/intake-check";
    const scope = scopeOf(event.data, job);
    const collectorId = text(event.data, "collector_id", job);
    if (event.data.check === "count") {
      const counted = await step.run("count", () => workIntakeRunner().count(scope, collectorId));
      return { check: "count", outcome: counted?.outcome ?? "skipped" };
    }
    const force = event.data.force === true;
    const summary: WorkReconcileSummary = { ok: true, pages: 0, handled: 0, missed: 0 };
    const changes: WorkIntakeChange[] = [];
    for (let index = 0; index < RECONCILE_MAX_PAGES; index += 1) {
      // Each page is its own step, so a retry repeats only the page that
      // failed. The runner stores the page's items before it moves the cursor.
      const page = await step.run(`page-${index}`, () =>
        workIntakeRunner().reconcilePage(scope, collectorId, force),
      );
      if (page.kind === "skipped") {
        if (index === 0 && page.reason !== "scope_invalid") return { check: "reconcile", skipped: page.reason };
        if (index === 0) {
          summary.ok = false;
          summary.error = NO_LINKED_REPOSITORIES_ERROR;
        }
        break;
      }
      if (page.kind === "failed") {
        summary.ok = false;
        summary.error = page.error;
        break;
      }
      summary.pages += 1;
      summary.handled += page.handled;
      summary.missed += page.missed;
      changes.push(...page.changes);
      if (!page.hasMore) break;
    }
    const health = await step.run("finish", () => workIntakeRunner().finishReconcile(scope, collectorId, summary));
    if (changes.length > 0) await step.sendEvent("item-received", itemReceivedEvents(scope, changes));
    return { check: "reconcile", ...summary, health: health?.health ?? null };
  },
);

/** True for an item revision: a whole number from 1. */
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The item an inngest/function.failed event's original event named, the
 * revision it was about, and whether a person asked for the run. An event
 * sent before events carried a revision names none.
 */
function failedItem(
  data: Record<string, unknown>,
): { scope: WorkIntakeScope; item: string; reason: string; run: WorkTriageFailedRun } | null {
  const original = (data.event ?? null) as { data?: Record<string, unknown> } | null;
  const inner = original?.data;
  if (!inner || typeof inner.org_id !== "string" || typeof inner.workspace_id !== "string" || typeof inner.item_id !== "string") {
    return null;
  }
  const error = (data.error ?? null) as { message?: unknown } | null;
  const message = typeof error?.message === "string" && error.message !== "" ? error.message : "an unknown error";
  return {
    scope: { orgId: inner.org_id, workspaceId: inner.workspace_id },
    item: inner.item_id,
    reason: `Triage could not run: ${message.slice(0, 500)}. Retry triage, or set the priority yourself.`,
    run: {
      ...(isRevision(inner.revision) ? { revision: inner.revision } : {}),
      retry: inner.change === "retry",
    },
  };
}

export const [workIntakeTriage, workIntakeTriageOnFailure] = createFunction(
  {
    id: "work/intake-triage",
    retries: 2,
    throttle: { limit: TRIAGE_RUNS_PER_MINUTE, period: "1m", key: "event.data.workspace_id" },
    concurrency: { limit: 1, key: "event.data.item_id" },
    onFailure: async ({ event, step }) => {
      const failed = failedItem(event.data);
      if (failed === null) return { recorded: false };
      await step.run("record-failure", () =>
        workIntakeRunner().recordTriageFailure(failed.scope, failed.item, failed.reason, failed.run),
      );
      return { recorded: true };
    },
  },
  { event: "work/item.received" },
  async ({ event, step }) => {
    const job = "work/intake-triage";
    const scope = scopeOf(event.data, job);
    const item = text(event.data, "item_id", job);
    const retry = event.data.change === "retry";
    return step.run("triage", () => workIntakeRunner().triage(scope, item, retry));
  },
);

export const [workIntakePrune] = createFunction(
  { id: "work/intake-prune", retries: 1, concurrency: { limit: 1 } },
  { cron: "41 4 * * *" },
  async ({ step }) => {
    const deleted = await step.run("prune", () => workIntakeRunner().prune(new Date()));
    return { deleted };
  },
);
