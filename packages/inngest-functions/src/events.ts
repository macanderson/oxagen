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
 * Asks `forge.pull-request-sync` to bring one pull request's stored record
 * up to date (ADR-288): its row in `forge.pull_requests`, the revision and
 * diff of its head commit, and the link to the run that named it. Sent by the
 * GitHub App webhook route for each `pull_request` delivery and each
 * workspace connected to the installation, with the pull request's facts from
 * the payload, by the tacho ingest handler beside `run/pull-request.linked`
 * for each link a run records, with the run's root session and no facts, and
 * by `forge.pull-request-backfill` for each link recorded before the forge
 * store existed, with the run's root session, the work order, or both
 * (ADR-292).
 *
 * Data is `{ orgId, workspaceId, provider, repository, number, pullKey,
 * facts?, link?, workOrderId? }`. `pullKey` names the pull request within
 * the workspace, and the function runs one event per key at a time. The id
 * names the delivery or the link, so a re-sent one asks once.
 */
export const FORGE_PULL_REQUEST_OBSERVED_EVENT = "forge/pull-request.observed";

/**
 * Says a pull request's head commit now has a stored diff (ADR-288). Sent by
 * `forge.pull-request-sync` once per revision, with the id
 * `forge-diff-ready:<revision id>`, after the revision row names the stored
 * bytes. Work outcome checks and other readers that need the exact diff a
 * head carried subscribe to it. `forge.revision-certification` queues each
 * revision for the witness from it (ADR-294). Data is `{ orgId, workspaceId,
 * pullRequestId, revisionId, provider, repository, number, headSha, diffKey,
 * diffSha256 }`.
 */
export const FORGE_PULL_REQUEST_DIFF_READY_EVENT =
  "forge/pull-request-diff.ready";

/** The data of `forge/pull-request-diff.ready`. */
export type ForgePullRequestDiffReadyEventData = {
  orgId: string;
  workspaceId: string;
  /** `forge.pull_requests.id`. */
  pullRequestId: string;
  /** `forge.pull_request_revisions.id`. */
  revisionId: string;
  provider: "github" | "gitlab";
  repository: string;
  number: number;
  headSha: string;
  /** The stored diff's object key. */
  diffKey: string;
  /** The stored diff's sha256, in lower-case hex. */
  diffSha256: string;
};

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
