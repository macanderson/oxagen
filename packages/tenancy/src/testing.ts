import { runInTenantScope, type TenantScope } from "./scope";

export const TEST_ORG = "00000000-0000-0000-0000-00000000a000";
export const TEST_WS = "00000000-0000-0000-0000-00000000b000";
export const TEST_SCOPE: TenantScope = { orgId: TEST_ORG, workspaceId: TEST_WS };

/** Run a unit-test body inside a tenant scope without ceremony. */
export function withTestScope<T>(fn: () => T, scope: TenantScope = TEST_SCOPE): T {
  return runInTenantScope(scope, fn);
}
