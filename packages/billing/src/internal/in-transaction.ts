/**
 * Run a billing write inside the caller's transaction, or open one.
 *
 * Every billing write that can be part of a larger settlement takes an
 * optional `Tx`. When the caller holds one, the write joins it so the
 * ledger row, the counter and the settlement marker commit or roll back
 * together. When it does not, the write opens its own. Three functions
 * carried three copies of that branch; this is the one seam.
 *
 * `open` names the transaction that is opened when none was passed. It
 * defaults to `withTenantDb`, which is right for a write made inside a
 * tenant scope. A recorder that runs after the request's scope is gone
 * (`recordSpend`, fired from the AI SDK's `onFinish`) passes `withSystemDb`,
 * because `withTenantDb` would throw for want of a scope.
 */
import { withTenantDb, type Tx } from "@oxagen/database";

export type OpenTransaction = <T>(run: (tx: Tx) => Promise<T>) => Promise<T>;

export function inTransaction<T>(
  transaction: Tx | undefined,
  run: (tx: Tx) => Promise<T>,
  open: OpenTransaction = withTenantDb,
): Promise<T> {
  return transaction ? run(transaction) : open(run);
}
