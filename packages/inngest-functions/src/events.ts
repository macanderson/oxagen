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
 * Asks `run.pull-request-backfill` to store a row for one pull request link
 * a run recorded, and to read its state once from the forge (ADR-192). Sent
 * by the tacho ingest handler for each root session and URL a batch's
 * `oxagen:pr_link` or `pr.url` frames name, with an id that holds for that
 * pair, so a re-sent batch asks once. Data is
 * `{ orgId, workspaceId, rootSessionUuid, url }`.
 */
export const RUN_PULL_REQUEST_LINKED_EVENT = "run/pull-request.linked";
