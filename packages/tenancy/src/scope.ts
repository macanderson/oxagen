import { AsyncLocalStorage } from "node:async_hooks";
import { TenantScopeError } from "./errors";

/** Who is acting inside the current tenant scope (OXA principal spine). */
export type PrincipalKind = "human" | "agent" | "service";

/**
 * Principal attribution carried alongside the tenant ids so every data-layer
 * seam (ClickHouse inserts, graph queries, audit rows) can answer
 * "who initiated → which agent → which capability" without per-callsite
 * threading. All fields are attribution metadata, NEVER an authorization
 * boundary — IAM decides access; this records who the decision was for.
 */
export interface PrincipalAttribution {
  /**
   * Resolved IAM principal uuid (`principals.id`), or null when the IAM
   * resolver did not run (non-enterprise tier fast-path, unbootstrapped
   * surfaces) or found no principal row.
   */
  readonly principalId: string | null;
  /** Kind of the acting principal. Null exactly when principalId is null. */
  readonly principalKind: PrincipalKind | null;
  /**
   * The originating human user uuid (`CapabilityContext.userId`). Present
   * even when the acting principal is an agent — this is the "who initiated"
   * link of the accountability chain.
   */
  readonly userId: string | null;
  /** Canonical capability name being invoked, e.g. "ontology.query". */
  readonly capabilityName: string | null;
}

export interface TenantScope extends Partial<PrincipalAttribution> {
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

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ["human", "agent", "service"];

/**
 * Validate the optional attribution fields. Fail-closed like the tenant ids:
 * a present-but-garbage id is a bug upstream, never something to persist.
 * Null/undefined are legal — attribution is best-effort by design.
 */
function assertAttribution(scope: TenantScope): void {
  if (scope.principalId != null) assertUuid(scope.principalId, "principalId");
  if (scope.userId != null) assertUuid(scope.userId, "userId");
  if (
    scope.principalKind != null &&
    !PRINCIPAL_KINDS.includes(scope.principalKind)
  ) {
    throw new TenantScopeError(
      `Invalid principalKind: ${JSON.stringify(scope.principalKind)}`,
    );
  }
}

/** Validate + enter scope. Fail-closed: empty/invalid ids throw. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  assertUuid(scope.orgId, "orgId");
  assertUuid(scope.workspaceId, "workspaceId");
  assertAttribution(scope);
  return als.run(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId ?? null,
      principalKind: scope.principalKind ?? null,
      userId: scope.userId ?? null,
      capabilityName: scope.capabilityName ?? null,
    },
    fn,
  );
}

/**
 * Enrich the ACTIVE scope with principal attribution and run `fn` inside the
 * enriched scope. The kernel calls this after the IAM resolver returns —
 * scope entry happens before the principal is known, so enrichment is a
 * nested ALS run rather than a mutation (scopes are immutable snapshots).
 *
 * No-op passthrough when no scope is active: unscoped capabilities carry no
 * tenant ids, and attribution without a tenant is meaningless.
 */
export function runWithPrincipal<T>(
  attribution: Partial<PrincipalAttribution>,
  fn: () => T,
): T {
  const current = als.getStore();
  if (!current) return fn();
  return runInTenantScope({ ...current, ...attribution }, fn);
}

const EMPTY_ATTRIBUTION: PrincipalAttribution = {
  principalId: null,
  principalKind: null,
  userId: null,
  capabilityName: null,
};

/**
 * The active scope's principal attribution, or all-null when no scope is
 * active or the scope carries no attribution. NEVER throws — telemetry
 * stamping must not turn an unattributed write into a failed write.
 */
export function getPrincipalAttribution(): PrincipalAttribution {
  const s = als.getStore();
  if (!s) return EMPTY_ATTRIBUTION;
  return {
    principalId: s.principalId ?? null,
    principalKind: s.principalKind ?? null,
    userId: s.userId ?? null,
    capabilityName: s.capabilityName ?? null,
  };
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
