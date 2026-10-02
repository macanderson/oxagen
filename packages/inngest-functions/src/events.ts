/**
 * Event names more than one sender needs, kept apart from the functions that
 * trigger on them.
 *
 * A function module carries its own trigger name, which is the right place
 * for it while the sender is another function in the same package. It stops
 * being the right place as soon as something outside the package sends the
 * event: importing `cost.price-book-reprice` for its name pulls the billing
 * package, the durable-function factory, the event client and the logger into
 * a process that only wanted a string. `tools/scripts/price-book-sync.ts` is
 * that caller, and a manual cold apply has to request the same repricing the
 * hourly job requests, from the same name.
 */

/**
 * Sent after a write that backdated rows, by the hourly `cost.price-book-sync`
 * job, by `pnpm billing:price-book-sync --apply`, and by
 * `cost.price-book-reprice` to itself once per page. The nightly
 * `cost.daily-rollup` sends it as well, with no backdated write behind it, so
 * a row left incomplete by anything other than a sync is still repaired: a
 * first rollup holding a pre-sync book can insert its blank row after the pass
 * a sync started has already read the list. Consumed by
 * `cost.price-book-reprice`, which re-rolls every run whose cost is blank or
 * estimated.
 */
export const PRICE_BOOK_BACKDATED_EVENT = "cost/price-book.backdated";

/**
 * Sent by the tacho ingest handler after a batch lands model or tool frames
 * on a run, unless that batch also sealed it (the seal sends
 * `cost/run.sealed`). Consumed by `cost.run-progress`, which rebuilds the
 * run's `cost.run_totals` row from the frames recorded so far: an open run's
 * cost then reads as an estimate before it seals rather than nothing at all,
 * and frames that land after a seal are counted too. Debounced per run by the
 * consumer, so a sender need not throttle.
 */
export const RUN_PROGRESSED_EVENT = "cost/run.progressed";

/**
 * Asks `run.enrich` to name and summarise one run. Sent by the tacho ingest
 * handler in the batch that lands a run's first prompt, so a new run gets its
 * account within seconds rather than at the next sweep; by `summarize_run`
 * when an operator asks; and by `run.enrichment-sweep` every five minutes for
 * every run whose record changed since it was last read. Data is
 * `{ orgId, workspaceId, runPublicId }`.
 */
export const RUN_ENRICH_EVENT = "run/enrich";

/**
 * Asks `run.fit` for a sealed run's Model fit reading (#3893, ADR-201). Sent
 * by `cost.run-rollup` once the run's `cost.run_totals` row lands, because the
 * reading reads that row's output and reasoning tokens. Data is
 * `{ orgId, workspaceId, runId }`, where `runId` is the run's public id.
 */
export const RUN_FIT_REQUESTED_EVENT = "run/fit.requested";

/**
 * Asks `run.pull-request-backfill` to store a row for one pull request link
 * a run recorded, and to read its state once from the forge (ADR-192). Sent
 * by the tacho ingest handler for each root session and URL a batch's
 * `oxagen:pr_link` or `pr.url` frames name, with an id that holds for that
 * pair, so a re-sent batch asks once. Data is
 * `{ orgId, workspaceId, rootSessionUuid, url, opened? }`. `opened` is true
 * when a `pr_open` call recorded the link, and the backfill then puts the
 * Oxagen block and label on the pull request (ADR-252).
 */
export const RUN_PULL_REQUEST_LINKED_EVENT = "run/pull-request.linked";

/**
 * Starts the timeout of one interjection a host raised (#3941, D8). Sent by
 * the tacho ingest handler after the transaction that writes the
 * `agent.interjections` row for a `control.interject` frame, with the id
 * `interjection-raised:<interjection public id>`, so a re-sent batch starts
 * one timeout. Consumed by the interjection timeout function, which sleeps
 * until `expiresAt` and, when nobody has answered by then, writes the `deny`
 * answer with source `timeout`.
 */
export const AGENT_INTERJECTION_RAISED_EVENT = "agent/interjection.raised";

/**
 * The data `AGENT_INTERJECTION_RAISED_EVENT` carries. A type alias rather than
 * an interface: Inngest's `EventPayload` takes `Record<string, unknown>` data,
 * and only an object type alias satisfies that index signature.
 */
export type AgentInterjectionRaisedEventData = {
  /** The organization's uuid. */
  orgId: string;
  /** The workspace's uuid. */
  workspaceId: string;
  /** The interjection's public id (`inj_…`). */
  interjectionId: string;
  /** RFC 3339; the deadline the control plane computed, not the host's. */
  expiresAt: string;
};

/**
 * Asks `memory.curate` to settle one workspace's memory PRs and open the
 * day's memory PR (ADR-206). Sent by `run.reflect` when a sealed run leaves
 * 20 or more memories waiting in the workspace, and by `memory.curate-daily`
 * once a day for every workspace with memory work. Data is
 * `{ orgId, workspaceId }`. Deliveries for one workspace are debounced.
 */
export const MEMORY_CURATE_REQUESTED_EVENT = "memory/curate.requested";

/**
 * Asks `conversation.title` to replace a new in-app conversation's prompt
 * title with one the fast model writes (#4571). Sent after the insert
 * commits, by `chat.message.send` and by the assistant turn through the
 * sender `@oxagen/handlers/register` installs. Data is
 * `{ conversationId, orgId, workspaceId }`; the function reads the question
 * back inside the tenant scope.
 */
export const CONVERSATION_OPENED_EVENT = "chat/conversation.opened";

// ---------------------------------------------------------------------------
// work/: collectors, triage, plans, and done records (agent-work-spec.html,
// Shared contract). Every payload carries org_id, workspace_id, and the id of
// the row it names. The keys are snake_case because the Shared contract fixes
// them that way, unlike the camelCase events above.
// ---------------------------------------------------------------------------

/** The org and workspace every work/ event carries, both uuids. */
export type WorkEventScope = {
  org_id: string;
  workspace_id: string;
};

/**
 * One inbound event a collector heard. Sent by the collector webhook route
 * after verify passes and the work.inbound_events row commits. Consumed by
 * the fetch worker, which reads the item ids from the stored body and fetches
 * each item from the provider.
 */
export const WORK_EVENT_RECEIVED_EVENT = "work/event.received";

/** The data `WORK_EVENT_RECEIVED_EVENT` carries. */
export type WorkEventReceivedEventData = WorkEventScope & {
  /** The work.inbound_events row's uuid. */
  inbound_event_id: string;
};

/**
 * A work item that is new, or whose subject, description, or labels changed.
 * Sent by the fetch worker and the reconcile after the upsert commits, by
 * manual entry, and by a person's retry of triage (`retry`). Consumed by the
 * triage function.
 */
export const WORK_ITEM_RECEIVED_EVENT = "work/item.received";

/** The data `WORK_ITEM_RECEIVED_EVENT` carries. */
export type WorkItemReceivedEventData = WorkEventScope & {
  /** The work item's public id (`wi_…`). */
  item_id: string;
  change: "new" | "updated" | "retry";
};

/**
 * One collector to check now. Sent by the 15-minute reconcile sweep, the
 * nightly count, and `sync_work_collector`. Consumed by the collector check,
 * which reads one collector at a time.
 */
export const WORK_COLLECTOR_CHECK_EVENT = "work/collector.check.requested";

/** The data `WORK_COLLECTOR_CHECK_EVENT` carries. */
export type WorkCollectorCheckEventData = WorkEventScope & {
  /** The work.collectors row's uuid. */
  collector_id: string;
  /** `reconcile` reads changes since the cursor. `count` compares open items. */
  check: "reconcile" | "count";
  /** True to read a failing collector anyway, as after a person reconnects it. */
  force: boolean;
};

/**
 * A triage decision was stored for a work item. Sent by the triage function
 * after the work.triage_decisions row commits. Consumed by the planner, which
 * places a ready item into a batch.
 */
export const WORK_ITEM_TRIAGED_EVENT = "work/item.triaged";

/** The data `WORK_ITEM_TRIAGED_EVENT` carries. */
export type WorkItemTriagedEventData = WorkEventScope & {
  /** The work item's public id (`wi_…`). */
  item_id: string;
  /** The triage decision's public id (`tri_…`). */
  decision_id: string;
};

/**
 * The plan changed. Sent each time planWorkOrders runs again: an item became
 * ready, a slot freed, or a work order finished. Consumed by the sender at
 * level 1 and above, and by the plan page, which always shows the latest plan.
 */
export const WORK_PLAN_UPDATED_EVENT = "work/plan.updated";

/** The data `WORK_PLAN_UPDATED_EVENT` carries. */
export type WorkPlanUpdatedEventData = WorkEventScope & {
  /** The plan's id. */
  plan_id: string;
};

/**
 * One workflow stage of a work order finished. Sent when the stage's session
 * ends. Consumed by evaluateWorkOrder, which moves the work order on, and by
 * decide, which reads the stage's evidence into the done record's verdict.
 */
export const WORK_STAGE_COMPLETED_EVENT = "work/stage.completed";

/** The data `WORK_STAGE_COMPLETED_EVENT` carries. */
export type WorkStageCompletedEventData = WorkEventScope & {
  /** The work order's id. */
  work_order_id: string;
  /** The stage's role in its workflow file, such as `Fix`. */
  role: string;
  /** The session that ran the stage. */
  session_id: string;
};

/**
 * A done record has a new verdict. Sent after the work.done_verdicts row
 * commits. Consumed by autonomyAllows before a merge, by write-back, and by
 * the training export, which waits out the label window.
 */
export const WORK_DONE_VERDICT_EVENT = "work/done.verdict";

/** The data `WORK_DONE_VERDICT_EVENT` carries. */
export type WorkDoneVerdictEventData = WorkEventScope & {
  /** The done record's lock digest (`sha256:…`). */
  record_digest: string;
  verdict: "pending" | "held" | "proven" | "broken";
};

/**
 * A scope's autonomy level changed. Sent after the work.autonomy_events row
 * commits: a steering PR merged a new level, or Oxagen lowered one after a
 * revert, an escaped defect, or a rejected sample. Consumed by whatever acts
 * next in that scope, which reads the level at the moment it acts.
 */
export const WORK_AUTONOMY_CHANGED_EVENT = "work/autonomy.changed";

/** The data `WORK_AUTONOMY_CHANGED_EVENT` carries. */
export type WorkAutonomyChangedEventData = WorkEventScope & {
  /** The [[autonomy]] scope: a label, or a repository with optional path globs. */
  scope: { label: string } | { repo: string; paths?: string[] };
  to_level: 0 | 1 | 2 | 3;
  cause: "steering_pr" | "revert" | "escaped_defect" | "sample_rejected";
};
