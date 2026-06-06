import { AsyncLocalStorage } from "node:async_hooks";
import { TenantScopeError } from "./errors";

export interface TenantScope {
  readonly orgId: string;
  readonly workspaceId: string;
}

const als = new AsyncLocalStorage<TenantScope>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new TenantScopeError(
      `Invalid ${field}: expected a uuid, got ${JSON.stringify(value)}`,
    );
  }
}

/** Validate + enter scope. Fail-closed: empty/invalid ids throw. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  assertUuid(scope.orgId, "orgId");
  assertUuid(scope.workspaceId, "workspaceId");
  return als.run({ orgId: scope.orgId, workspaceId: scope.workspaceId }, fn);
}

/** The active scope, or null when none is set. */
export function getScope(): TenantScope | null {
  return als.getStore() ?? null;
}

/** The active scope, or throw — used by every data accessor. */
export function requireScope(): TenantScope {
  const s = als.getStore();
  if (!s) {
    throw new TenantScopeError("No active tenant scope — data access out of bounds");
  }
  return s;
}
