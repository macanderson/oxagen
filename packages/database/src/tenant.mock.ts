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

/**
 * Alias for suites that mock the organisation-wide read seam (`withOrgDb`,
 * ADR-086). Same shape: the callback runs against the suite's fake tx. A unit
 * test cannot tell the three seams apart — which one a read uses is decided by
 * RLS and the data plane, and neither exists in a unit test — so the witness
 * for that difference is the rls-integration suite, not this double.
 */
export const makeWithOrgDbMock = makeWithTenantDbMock;
