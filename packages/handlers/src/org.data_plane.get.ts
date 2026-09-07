// audit-exempt: read-only binding fetch that returns NO secret material — the
// kernel's capability.invoke_* audit already records who read it. Only the
// mutation (org.data_plane.set) warrants a domain-specific data_plane.updated
// row.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  orgDataPlaneGet,
  type OrgDataPlaneGetOutput,
} from "@oxagen/oxagen/contracts/org.data_plane.get";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, type DataPlaneRow } from "@oxagen/database";
import type { DataPlaneKind } from "@oxagen/tenancy";
import { logger } from "./logger";

/**
 * Endpoint host of a dedicated plane, derived WITHOUT decrypting the envelope
 * where possible — but the host lives inside the encrypted config, so this
 * takes the already-decrypted config and pulls only the non-secret parts.
 *
 * `null` for a shared plane: the platform endpoint is process env, not the
 * organisation's business, and echoing it back would leak infrastructure
 * topology to every org admin.
 */
export function hostFor(
  kind: DataPlaneKind,
  config: Record<string, unknown> | undefined,
): string | null {
  if (!config) return null;
  if (kind === "postgres") {
    return typeof config.host === "string" ? config.host : null;
  }
  const raw = kind === "neo4j" ? config.uri : config.url;
  if (typeof raw !== "string") return null;
  try {
    // `new URL` handles neo4j+s:// and https:// alike; `.host` is host:port and
    // never carries userinfo, so a DSN-style credential cannot leak here.
    return new URL(raw).host;
  } catch {
    // An unparseable endpoint is a config problem, not a reason to fail the
    // read — the operator still needs to see mode + status to fix it.
    return null;
  }
}

/**
 * Project a row (plus its decrypted config, when the caller has one) onto the
 * REDACTED wire shape. ADR-042 §4: never the DSN, never a credential. Anything
 * not listed here does not leave the process.
 */
export function toBindingDto(args: {
  kind: DataPlaneKind;
  row: Pick<
    DataPlaneRow,
    "mode" | "status" | "schemaVersion" | "lastVerifiedAt" | "rotatedAt"
  > | null;
  config?: Record<string, unknown>;
}): OrgDataPlaneGetOutput {
  const { kind, row } = args;
  if (!row) {
    // No row means the shared plane (ADR-042 §1) — the same answer the
    // resolver gives, so the UI and the runtime never disagree.
    return {
      kind,
      mode: "shared",
      status: "active",
      host: null,
      database: null,
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    };
  }
  const mode = row.mode === "dedicated" ? "dedicated" : "shared";
  const status =
    row.status === "active"
      ? "active"
      : row.status === "degraded"
        ? "degraded"
        : "disabled";
  const database =
    mode === "dedicated" && typeof args.config?.database === "string"
      ? args.config.database
      : null;
  return {
    kind,
    mode,
    status,
    host: mode === "dedicated" ? hostFor(kind, args.config) : null,
    database,
    schemaVersion: row.schemaVersion ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
  };
}

/**
 * get_data_plane — where does this organisation's data for one store live, and
 * is that plane healthy?
 *
 * withSystemDb, not withTenantDb: `org.data_planes` is platform state that
 * always lives on the SHARED plane (ADR-042 §2), and reading it through
 * withTenantDb would ask the resolver to resolve the very table that decides
 * what the resolver returns. The org filter below is therefore the isolation
 * boundary for this read, and it is an explicit equality on `ctx.orgId` — the
 * kernel's IAM gate has already established the caller is an Owner/Admin of it.
 *
 * The read intentionally does NOT decrypt the envelope in the common case: the
 * only fields it needs from the config are host and database name, and the
 * platform resolver already caches a decrypted binding. Rather than duplicate
 * the KMS path here, it reuses `loadDataPlaneBinding`, which is the one place
 * an envelope is ever opened.
 */
export const orgDataPlaneGetHandler: CapabilityHandler<
  typeof orgDataPlaneGet
> = async (input, ctx) => {
  const kind = input.kind;
  const row = await withSystemDb((tx) =>
    tx.query.dataPlanes.findFirst({
      where: and(
        eq(schema.dataPlanes.orgId, ctx.orgId),
        eq(schema.dataPlanes.kind, kind),
        isNull(schema.dataPlanes.deletedAt),
      ),
    }),
  );

  let config: Record<string, unknown> | undefined;
  if (row?.mode === "dedicated") {
    // Only a dedicated row has an envelope, and only then do we need the host
    // and database name out of it. Import lazily so the shared-plane path (the
    // overwhelming majority) never pulls the KMS module in.
    const { loadDataPlaneBinding } = await import(
      "@oxagen/database/data-plane"
    );
    const binding = await loadDataPlaneBinding(ctx.orgId, kind);
    config = binding.config as unknown as Record<string, unknown> | undefined;
  }

  const dto = toBindingDto({ kind, row: row ?? null, config });
  logger.info(
    // Never the config: mode/status/kind only.
    { orgId: ctx.orgId, kind, mode: dto.mode, status: dto.status, surface: ctx.surface },
    "org.data_plane.get: returned the organisation's plane binding",
  );
  return dto;
};
