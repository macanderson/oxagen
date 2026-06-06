import type { Tx } from "./tenant";

/**
 * Test double for withTenantDb / withSystemDb: invokes the callback with the
 * provided fake tx, no transaction, no GUC. Suites pass their existing fake db
 * object. The same shape works for both wrappers (system bypass vs scoped).
 */
export function makeWithTenantDbMock(fakeTx: unknown) {
  return async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(fakeTx as Tx);
}

/** Alias for clarity in suites that mock the bypass wrapper. */
export const makeWithSystemDbMock = makeWithTenantDbMock;
