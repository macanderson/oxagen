import type { Tx } from "./tenant";

/**
 * Test double for withTenantDb: invokes the callback with the provided fake
 * tx, no transaction, no GUC. Suites pass their existing fake db object.
 */
export function makeWithTenantDbMock(fakeTx: unknown) {
  return async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(fakeTx as Tx);
}
