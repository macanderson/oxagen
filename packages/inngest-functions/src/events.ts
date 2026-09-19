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
 * `cost.price-book-reprice` to itself once per page. Consumed by
 * `cost.price-book-reprice`, which re-rolls every run whose cost is blank or
 * estimated and which the newly backdated prices can now price.
 */
export const PRICE_BOOK_BACKDATED_EVENT = "cost/price-book.backdated";
