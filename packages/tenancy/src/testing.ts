import { runInTenantScope, type TenantScope } from "./scope";

/** Fixed org uuid every unit test shares, so scoped fixtures line up. */
export const TEST_ORG = "00000000-0000-0000-0000-00000000a000";
/** Fixed workspace uuid paired with {@link TEST_ORG}. */
export const TEST_WS = "00000000-0000-0000-0000-00000000b000";
/**
 * The default scope `withTestScope` enters. Frozen for the same reason the
 * live scope snapshot is: it is a module-level singleton shared by every test
 * in the process, so one test mutating it would repoint the others' tenant.
 * Build a variant with a spread (`{ ...TEST_SCOPE, orgId }`), never in place.
 *
 * Tenant ids only — `runInTenantScope` fills the attribution fields with
 * explicit nulls, so the scope a test observes is wider than this constant.
 */
export const TEST_SCOPE: TenantScope = Object.freeze({
  orgId: TEST_ORG,
  workspaceId: TEST_WS,
});

/** Run a unit-test body inside a tenant scope without ceremony. */
export function withTestScope<T>(
  fn: () => T,
  scope: TenantScope = TEST_SCOPE,
): T {
  return runInTenantScope(scope, fn);
}
