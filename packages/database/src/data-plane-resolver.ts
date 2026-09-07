/**
 * The PLATFORM implementation of the ADR-042 data-plane resolver.
 *
 * `@oxagen/tenancy` owns the seam (`setDataPlaneResolver` / `resolveDataPlane`)
 * and must stay dependency-free, so the half that actually reads
 * `org.data_planes` and unwraps the KMS envelope lives here — the same shape as
 * `setKernelIAMRuntime` / `bootstrapIAMRuntime`. This package may depend on
 * `@oxagen/crypto` (a leaf); it must NOT depend on `@oxagen/plugins`, which
 * depends on us, so the envelope is opened with `@oxagen/crypto` directly
 * rather than through the plugin credential service.
 *
 * WHY withSystemDb: the binding row is read BEFORE a tenant scope's store is
 * chosen — `withTenantDb` would have to resolve the plane to read the table
 * that says which plane to use. Platform-level tables always live on the shared
 * plane (ADR-042 §2), so this read is a genuine, audited RLS bypass on the
 * shared singleton, exactly like identity resolution.
 *
 * SECRET HANDLING: the decrypted config never leaves this module except inside
 * a `DataPlaneBinding` handed to a store client. It is never logged, never
 * serialised into an error, and never returned by a read capability
 * (`get_data_plane` re-derives host + database name from it and drops the rest).
 */
import { and, eq, isNull } from "drizzle-orm";
import { decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";
import {
  setDataPlaneResolver,
  type ClickHousePlaneConfig,
  type DataPlaneBinding,
  type DataPlaneConfig,
  type DataPlaneKind,
  type DataPlaneMode,
  type DataPlaneStatus,
  type Neo4jPlaneConfig,
  type PostgresPlaneConfig,
} from "@oxagen/tenancy";
import { schema } from "./index";
import { withSystemDb } from "./tenant";
import { evictOrg } from "./data-plane-pool";
import { logger } from "./logger";

/**
 * Stable per-row key-version label for the data-plane envelope. Mirrors
 * MCP_CREDENTIAL_KEY_ID in @oxagen/plugins — bump on a KEK rotation so the
 * read path can route the decrypt by the stored key id.
 */
export const DATA_PLANE_KEY_ID = "data_plane_v1";

export interface ResolvedPlaneKms {
  readonly adapter: KmsAdapter;
  readonly keyId: string;
}

/**
 * Resolve the KMS adapter used to envelope data-plane configs. Sources its
 * master key from AUTH_TOKEN_ENCRYPTION_KEY (base64 256-bit), the same key the
 * plugin credential vault uses. Returns null when unset (local dev without
 * secrets) — callers must then refuse to STORE a dedicated config rather than
 * writing plaintext. NEVER log key material.
 */
export function resolveDataPlaneKms(): ResolvedPlaneKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: DATA_PLANE_KEY_ID,
  };
}

/**
 * How long a resolved binding is trusted without re-reading Postgres.
 *
 * Short on purpose. This cache sits in front of EVERY withTenantDb /
 * scopedSession / chInsert, so it has to be cheap; but a stale entry means a
 * disabled plane keeps taking writes, so the window is measured in seconds and
 * an explicit write invalidates immediately.
 */
export const DATA_PLANE_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  readonly binding: DataPlaneBinding;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(orgId: string, kind: DataPlaneKind): string {
  return `${orgId}:${kind}`;
}

/**
 * Drop cached bindings for one organisation (all kinds, or one) and close any
 * dedicated Postgres pool it holds. Called by `set_data_plane` after the write
 * so the new binding is live at once rather than after the TTL.
 */
export function invalidateDataPlaneCache(
  orgId: string,
  kind?: DataPlaneKind,
): void {
  if (kind) cache.delete(cacheKey(orgId, kind));
  else
    for (const key of cache.keys()) {
      if (key.startsWith(`${orgId}:`)) cache.delete(key);
    }
  // The pool is keyed by config digest, so a rotation would eventually miss it
  // anyway; evicting here closes the pool bound to the superseded credential
  // instead of leaving it open until LRU pressure removes it.
  if (kind === undefined || kind === "postgres") {
    evictOrg(orgId, "data-plane binding changed");
  }
}

/** Drop the entire cache. Process-level reset; tests. */
export function clearDataPlaneCache(): void {
  cache.clear();
}

/** The shared-plane binding — what "no row" means (ADR-042 §1). */
function sharedBinding(orgId: string, kind: DataPlaneKind): DataPlaneBinding {
  return {
    orgId,
    kind,
    mode: "shared",
    status: "active",
    configDigest: null,
    schemaVersion: null,
  };
}

/**
 * Narrow the free-text `mode` / `status` columns to the seam's closed unions.
 * The DB CHECK constraints guarantee valid values, but the columns are `text`;
 * an unrecognised value is treated as `disabled`, which fails CLOSED — the only
 * safe reading of "this row says something we do not understand".
 */
function narrowMode(value: string): DataPlaneMode {
  return value === "dedicated" ? "dedicated" : "shared";
}

function narrowStatus(value: string): DataPlaneStatus {
  if (value === "active") return "active";
  if (value === "degraded") return "degraded";
  return "disabled";
}

/**
 * Parse the decrypted JSON into the per-kind config shape. A structurally
 * invalid payload is a hard failure, not a shared-plane fallback: the row says
 * this organisation's data lives elsewhere, so silently using the platform
 * store would be the exact leak ADR-042 exists to prevent.
 */
export function parsePlaneConfig(
  kind: DataPlaneKind,
  json: unknown,
): DataPlaneConfig {
  const o = json as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o?.[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `data-plane config for ${kind} is missing the "${k}" field`,
      );
    }
    return v;
  };
  if (kind === "postgres") {
    const port = o?.port;
    const cfg: PostgresPlaneConfig = {
      host: str("host"),
      port: typeof port === "number" ? port : 5432,
      database: str("database"),
      username: str("username"),
      password: str("password"),
      ssl: typeof o?.ssl === "boolean" ? o.ssl : true,
      maxConnections:
        typeof o?.maxConnections === "number" ? o.maxConnections : undefined,
    };
    return cfg;
  }
  if (kind === "neo4j") {
    const cfg: Neo4jPlaneConfig = {
      uri: str("uri"),
      username: str("username"),
      password: str("password"),
      database: str("database"),
    };
    return cfg;
  }
  const cfg: ClickHousePlaneConfig = {
    url: str("url"),
    username: str("username"),
    password: str("password"),
    database: str("database"),
  };
  return cfg;
}

/**
 * Read one binding straight from Postgres, decrypting the envelope for a
 * dedicated row. Exported for the handlers, which need an uncached read.
 */
export async function loadDataPlaneBinding(
  orgId: string,
  kind: DataPlaneKind,
): Promise<DataPlaneBinding> {
  // withSystemDb: see the module docblock — the binding table is platform state
  // on the shared plane and is read before any plane has been chosen.
  const row = await withSystemDb((tx) =>
    tx.query.dataPlanes.findFirst({
      where: and(
        eq(schema.dataPlanes.orgId, orgId),
        eq(schema.dataPlanes.kind, kind),
        isNull(schema.dataPlanes.deletedAt),
      ),
    }),
  );

  if (!row) return sharedBinding(orgId, kind);

  const mode = narrowMode(row.mode);
  const status = narrowStatus(row.status);

  if (mode === "shared") {
    return {
      orgId,
      kind,
      mode,
      status,
      configDigest: row.configDigest ?? null,
      schemaVersion: row.schemaVersion ?? null,
    };
  }

  if (!row.configCiphertext || !row.configKeyId) {
    // The DB CHECK makes this unreachable; if it is ever reached the row is
    // corrupt and the organisation must fail closed, not fall back.
    throw new Error(
      `data-plane row for organisation ${orgId} (${kind}) is dedicated but ` +
        "carries no envelope — refusing to fall back to the shared plane",
    );
  }

  const kms = resolveDataPlaneKms();
  if (!kms) {
    throw new Error(
      `data-plane for organisation ${orgId} (${kind}) is dedicated but ` +
        "AUTH_TOKEN_ENCRYPTION_KEY is unset — cannot open the envelope",
    );
  }
  const plaintext = await decrypt(row.configCiphertext, row.configKeyId, {
    adapter: kms.adapter,
  });
  const config = parsePlaneConfig(
    kind,
    JSON.parse(plaintext.toString("utf8")) as unknown,
  );

  return {
    orgId,
    kind,
    mode,
    status,
    config,
    configDigest: row.configDigest ?? null,
    schemaVersion: row.schemaVersion ?? null,
  };
}

/**
 * The resolver injected into `@oxagen/tenancy`. Cached per (organisation,
 * store) for a short TTL; a read failure is NOT cached, so a transient DB blip
 * does not pin an organisation to a wrong answer.
 */
export async function platformDataPlaneResolver(
  orgId: string,
  kind: DataPlaneKind,
): Promise<DataPlaneBinding> {
  const key = cacheKey(orgId, kind);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.binding;

  const binding = await loadDataPlaneBinding(orgId, kind);
  cache.set(key, { binding, expiresAt: now + DATA_PLANE_CACHE_TTL_MS });
  return binding;
}

let bootstrapped = false;

/**
 * Wire the platform resolver into the tenancy seam. Call once per runtime at
 * bootstrap (apps/api, apps/mcp, apps/app instrumentation, any worker or
 * script that runs scoped store access). Forgetting it is SAFE but inert:
 * every organisation stays on the shared plane, which is what the platform did
 * before ADR-042 — it does not silently disable a gate.
 *
 * Idempotent: repeated calls (hot reload, memoised bootstrap retried after a
 * transient failure) re-register the same function without resetting the cache.
 */
export function bootstrapDataPlaneResolver(): void {
  setDataPlaneResolver(platformDataPlaneResolver);
  if (!bootstrapped) {
    bootstrapped = true;
    logger.info(
      { ttlMs: DATA_PLANE_CACHE_TTL_MS },
      "data-plane: platform resolver wired into the tenancy seam",
    );
  }
}

/** Test-only reset of the one-shot bootstrap log latch. */
export function __resetDataPlaneBootstrapForTests(): void {
  bootstrapped = false;
}
