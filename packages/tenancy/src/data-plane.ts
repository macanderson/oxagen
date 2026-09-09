/**
 * Organisation-scoped data-plane resolution seam (ADR-042).
 *
 * Oxagen calls tenants *organisations*, and a data plane is an
 * organisation-level binding of one store (`postgres` | `neo4j` |
 * `clickhouse`) to a physical endpoint. Two modes exist:
 *
 *   shared     the platform's own store — the process singleton every client
 *              already uses. This is the default and the only mode a fresh
 *              deployment ever sees.
 *   dedicated  a customer-controlled endpoint inside the customer's network.
 *              The three store clients open (and pool) a per-organisation
 *              connection for it.
 *
 * `@oxagen/tenancy` is the leaf every data client depends on, so it must stay
 * dependency-free: it cannot read `org.data_planes`, cannot decrypt a KMS
 * envelope, and must not import Drizzle. The binding therefore arrives through
 * an INJECTED resolver, exactly like `setKernelIAMRuntime` in the kernel — the
 * platform implementation lives in `@oxagen/database`
 * (`bootstrapDataPlaneResolver()`) and is wired once at surface bootstrap.
 *
 * Until a resolver is injected the default resolver answers `shared` for every
 * organisation, which is the correct fail-SAFE default: `shared` is the plane
 * the process is already configured for, so an unbootstrapped runtime behaves
 * exactly as it did before ADR-042 rather than losing access to its own data.
 * Fail-CLOSED applies to the other axis — a plane whose `status` is `degraded`
 * or `disabled` throws `DataPlaneUnavailableError` and never silently falls
 * back to the shared plane, because that fallback would write one tenant's
 * data into the platform store the customer explicitly moved it out of.
 */

/** The three stores that can be bound per organisation. */
export type DataPlaneKind = "postgres" | "neo4j" | "clickhouse";

/** Shared = the platform plane; dedicated = a customer-controlled endpoint. */
export type DataPlaneMode = "shared" | "dedicated";

/**
 * Health of a plane.
 *   active    usable.
 *   degraded  reachable but not trustworthy for writes — e.g. its schema
 *             version lags the platform's (ADR-042 §3).
 *   disabled  administratively switched off.
 * Only `active` admits traffic; the other two fail closed.
 */
export type DataPlaneStatus = "active" | "degraded" | "disabled";

/** Connection configuration for a dedicated Postgres plane. */
export interface PostgresPlaneConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  /** TLS to the customer endpoint. Defaults to on for a dedicated plane. */
  readonly ssl?: boolean;
  /** Per-process pool ceiling for this organisation. */
  readonly maxConnections?: number;
}

/** Connection configuration for a dedicated Neo4j plane. */
export interface Neo4jPlaneConfig {
  /** Full bolt/neo4j URI including scheme, e.g. `neo4j+s://graph.acme.example`. */
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/** Connection configuration for a dedicated ClickHouse plane. */
export interface ClickHousePlaneConfig {
  /** Full HTTP(S) endpoint, e.g. `https://ch.acme.example:8443`. */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export type DataPlaneConfig =
  | PostgresPlaneConfig
  | Neo4jPlaneConfig
  | ClickHousePlaneConfig;

/**
 * One organisation's binding for one store.
 *
 * `config` is present only for `dedicated` planes — a shared plane's
 * connection details are process env, never per-organisation state. It carries
 * plaintext credentials in memory and MUST NOT be logged, serialised into an
 * error, or returned by a read capability.
 */
export interface DataPlaneBinding {
  readonly orgId: string;
  readonly kind: DataPlaneKind;
  readonly mode: DataPlaneMode;
  readonly status: DataPlaneStatus;
  /** Only set when `mode === "dedicated"`. Secret material — never log it. */
  readonly config?: DataPlaneConfig;
  /**
   * Digest of the stored configuration. Part of the client-pool cache key, so
   * a rotated credential produces a new key and the stale pool is evicted and
   * closed instead of being reused against a revoked password.
   */
  readonly configDigest?: string | null;
  /** Applied schema version of a dedicated plane; null for shared. */
  readonly schemaVersion?: string | null;
}

/** The injected resolver's shape. */
export type DataPlaneResolver = (
  orgId: string,
  kind: DataPlaneKind,
) => Promise<DataPlaneBinding>;

/**
 * Raised when a resolved plane cannot serve traffic. Typed with a stable
 * `code` so surfaces map it to a 503 without string-matching the message,
 * mirroring `TenantScopeError`.
 */
export class DataPlaneUnavailableError extends Error {
  readonly code = "data_plane_unavailable" as const;
  readonly orgId: string;
  readonly kind: DataPlaneKind;
  readonly status: DataPlaneStatus;

  constructor(binding: {
    orgId: string;
    kind: DataPlaneKind;
    status: DataPlaneStatus;
  }) {
    super(
      `Data plane for organisation ${binding.orgId} (${binding.kind}) is ` +
        `${binding.status} — refusing the operation. A degraded or disabled ` +
        "plane NEVER falls back to the shared platform plane: that would " +
        "write tenant data into the store the customer moved it out of.",
    );
    this.name = "DataPlaneUnavailableError";
    this.orgId = binding.orgId;
    this.kind = binding.kind;
    this.status = binding.status;
  }
}

/**
 * The pre-bootstrap resolver: every organisation is on the shared plane. This
 * is what the whole platform runs on until `org.data_planes` carries a row, and
 * it is what keeps `@oxagen/tenancy` free of a database dependency.
 */
const defaultResolver: DataPlaneResolver = async (orgId, kind) => ({
  orgId,
  kind,
  mode: "shared",
  status: "active",
  configDigest: null,
  schemaVersion: null,
});

let _resolver: DataPlaneResolver | null = null;

/**
 * Inject the platform resolver. Called once per process at surface bootstrap
 * (`bootstrapDataPlaneResolver()` from `@oxagen/database`). Idempotent by
 * overwrite — the last writer wins, which matches every other gate seam.
 */
export function setDataPlaneResolver(resolver: DataPlaneResolver): void {
  _resolver = resolver;
}

/** Drop the injected resolver, restoring the shared-plane default. For tests. */
export function clearDataPlaneResolver(): void {
  _resolver = null;
}

/** True when a platform resolver has been injected. */
export function hasDataPlaneResolver(): boolean {
  return _resolver !== null;
}

/**
 * Resolve one organisation's binding for one store. Never throws for an
 * unbound organisation — absence of a row means the shared plane (ADR-042 §1).
 */
export function resolveDataPlane(
  orgId: string,
  kind: DataPlaneKind,
): Promise<DataPlaneBinding> {
  return (_resolver ?? defaultResolver)(orgId, kind);
}

/**
 * Fail-closed guard every store client runs on the resolved binding before it
 * touches a connection. Throws `DataPlaneUnavailableError` for a non-active
 * plane, and for a `dedicated` plane that arrived without a config (a resolver
 * bug that would otherwise silently degrade into using the shared singleton).
 */
export function assertDataPlaneUsable(binding: DataPlaneBinding): void {
  if (binding.status !== "active") {
    throw new DataPlaneUnavailableError(binding);
  }
  if (binding.mode === "dedicated" && binding.config === undefined) {
    throw new DataPlaneUnavailableError({
      orgId: binding.orgId,
      kind: binding.kind,
      status: "degraded",
    });
  }
}
