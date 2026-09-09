/**
 * Shared host-side machinery for the Tacho handlers: resolving the enrolled
 * host behind an API key, computing and signing the policy bundle, and
 * building the control envelope every machine response carries.
 */
import { CapabilityError } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  type PolicyBundle,
  TACHO_BUNDLE_SCHEMA,
  controlEnvelopeSchema,
  tachoBundleModeSchema,
  tachoHostStatusSchema,
} from "@oxagen/oxagen/tacho/schemas";
import { digestJcs, type JsonValue } from "@oxagen/tacho";
import { schema } from "@oxagen/database";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { type BundleSigner, bundleSignerFromEnv } from "./tacho-bundle-signing";
import { tachoHostApiKeyScopeSchema } from "./tacho-enrollment";

export type TachoHostRow = typeof schema.tachoHosts.$inferSelect;
export type ControlEnvelope = z.output<typeof controlEnvelopeSchema>;

/** The transaction shape the helpers need; kept narrow so tests can fake it. */
export interface TachoTx {
  query: {
    apiKeys: { findFirst: (args: unknown) => Promise<unknown> };
    tachoHosts: { findFirst: (args: unknown) => Promise<unknown> };
    authorizationDenyGenerations: {
      findMany: (args: unknown) => Promise<unknown>;
    };
    tachoControlCommands: { findMany: (args: unknown) => Promise<unknown> };
  };
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
}

export function tachoDenied(
  capability: string,
  message: string,
): CapabilityError {
  return new CapabilityError(capability, "authz_denied", message);
}

/**
 * The enrolled host behind the calling API key, or a denial. Checks, in
 * order: an API key is present, it is live, its scope is the reserved
 * `tacho_host_v1` purpose, the host it names exists in this tenant, and the
 * host is neither revoked nor past its enrollment expiry.
 */
export async function resolveEnrolledHost(
  capability: string,
  ctx: CapabilityContext,
  tx: TachoTx,
  claimedHostEnrollmentId: string,
): Promise<TachoHostRow> {
  if (!ctx.apiKeyId) {
    throw tachoDenied(
      capability,
      "Forbidden: enrolled Tacho host API key required",
    );
  }
  const apiKey = (await tx.query.apiKeys.findFirst({
    where: and(
      eq(schema.apiKeys.id, ctx.apiKeyId),
      isNull(schema.apiKeys.deletedAt),
      or(
        isNull(schema.apiKeys.expiresAt),
        gt(schema.apiKeys.expiresAt, new Date()),
      ),
    ),
    columns: { id: true, scope: true },
  })) as { id: string; scope: unknown } | undefined;
  const scope = tachoHostApiKeyScopeSchema.safeParse(apiKey?.scope);
  if (!apiKey || !scope.success) {
    throw tachoDenied(
      capability,
      "Forbidden: enrolled Tacho host API-key scope required",
    );
  }
  if (scope.data.host_enrollment_id !== claimedHostEnrollmentId) {
    throw tachoDenied(capability, "Forbidden: host enrollment mismatch");
  }
  const host = (await tx.query.tachoHosts.findFirst({
    where: and(
      eq(schema.tachoHosts.publicId, scope.data.host_enrollment_id),
      eq(schema.tachoHosts.apiKeyId, apiKey.id),
    ),
  })) as TachoHostRow | undefined;
  if (!host) {
    throw tachoDenied(capability, "Forbidden: unknown Tacho host");
  }
  if (host.status === "revoked") {
    throw tachoDenied(capability, "Forbidden: Tacho host enrollment revoked");
  }
  if (host.expiresAt.getTime() <= Date.now()) {
    throw tachoDenied(capability, "Forbidden: Tacho host enrollment expired");
  }
  return host;
}

export interface DenyGeneration {
  org: number;
  workspace: number;
}

/** The current org and workspace deny generations (iam.authorization_deny_generations). */
export async function readDenyGeneration(
  tx: TachoTx,
  orgId: string,
  workspaceId: string,
): Promise<DenyGeneration> {
  const rows = (await tx.query.authorizationDenyGenerations.findMany({
    where: eq(schema.authorizationDenyGenerations.orgId, orgId),
    columns: { workspaceId: true, generation: true },
  })) as Array<{ workspaceId: string | null; generation: number }>;
  let org = 0;
  let workspace = 0;
  for (const row of rows) {
    if (row.workspaceId === null) org = row.generation;
    else if (row.workspaceId === workspaceId) workspace = row.generation;
  }
  return { org, workspace };
}

/** The unsigned bundle for a host at this moment (spec section 7.1). */
export function unsignedBundle(
  host: TachoHostRow,
  denyGeneration: DenyGeneration,
  now: Date = new Date(),
): Omit<PolicyBundle, "signature"> {
  const status = tachoHostStatusSchema.parse(host.status);
  const mode = tachoBundleModeSchema.parse(host.mode);
  // Version and etag cover the policy content only, never the timestamps, so
  // an unchanged bundle answers not_modified across polls.
  const content = {
    host_enrollment_id: host.publicId,
    host_status: status,
    deny_generation: denyGeneration,
    permissions: {
      allow: [] as string[],
      deny: [] as string[],
      ask: [] as string[],
    },
    tools: {} as PolicyBundle["tools"],
    budget: { mode: "observed" as const },
    context: { system: null },
    retention: { mode: "digest_only" as const, classes: [] as string[] },
    mode,
  };
  const etag = digestJcs(content as unknown as JsonValue).slice(
    "sha256:".length,
    "sha256:".length + 32,
  );
  return {
    schema: TACHO_BUNDLE_SCHEMA,
    version: (host.bundleVersionServed ?? 0) + 1,
    etag,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...content,
  };
}

export function requireBundleSigner(capability: string): BundleSigner {
  const signer = bundleSignerFromEnv();
  if (!signer) {
    // A deployment misconfiguration, not a decision about this caller.
    throw new Error(
      `Tacho bundle signing is not configured: TACHO_BUNDLE_SIGNING_PRIVATE_KEY is unset (${capability})`,
    );
  }
  return signer;
}

export function signBundle(
  signer: BundleSigner,
  unsigned: Omit<PolicyBundle, "signature">,
): PolicyBundle {
  return { ...unsigned, signature: signer.sign(unsigned) };
}

/** Pending commands for a host, marked delivered as they leave. */
export async function drainCommands(
  tx: TachoTx,
  host: TachoHostRow,
  now: Date = new Date(),
): Promise<ControlEnvelope["commands"]> {
  const rows = (await tx.query.tachoControlCommands.findMany({
    where: and(
      eq(schema.tachoControlCommands.hostId, host.id),
      eq(schema.tachoControlCommands.outcome, "pending"),
      or(
        isNull(schema.tachoControlCommands.expiresAt),
        gt(schema.tachoControlCommands.expiresAt, now),
      ),
    ),
    orderBy: [asc(schema.tachoControlCommands.issuedAt)],
    limit: 100,
  })) as Array<
    typeof schema.tachoControlCommands.$inferSelect & {
      sessionUuid?: string | null;
    }
  >;
  const delivered: ControlEnvelope["commands"] = [];
  for (const row of rows) {
    await tx
      .update(schema.tachoControlCommands)
      .set({ outcome: "delivered", deliveredAt: now, updatedAt: now })
      .where(eq(schema.tachoControlCommands.id, row.id));
    delivered.push({
      id: row.publicId,
      command: row.command as ControlEnvelope["commands"][number]["command"],
      session_uuid:
        (row.payload as { session_uuid?: string } | null)?.session_uuid ?? null,
      payload: (row.payload as Record<string, unknown>) ?? {},
      issued_at: row.issuedAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
    });
  }
  return delivered;
}

/** The control envelope every machine response carries (spec section 7.4). */
export async function controlEnvelope(
  tx: TachoTx,
  ctx: CapabilityContext,
  host: TachoHostRow,
  now: Date = new Date(),
): Promise<ControlEnvelope> {
  const denyGeneration = await readDenyGeneration(
    tx,
    ctx.orgId,
    ctx.workspaceId,
  );
  const bundle = unsignedBundle(host, denyGeneration, now);
  const commands = await drainCommands(tx, host, now);
  return controlEnvelopeSchema.parse({
    host_status: tachoHostStatusSchema.parse(host.status),
    deny_generation: denyGeneration,
    bundle_etag: bundle.etag,
    commands,
  });
}

/** Touch the host's liveness columns from what the daemon reported. */
export async function touchHost(
  tx: TachoTx,
  host: TachoHostRow,
  daemon:
    | {
        version?: string;
        uptime_s?: number;
        spool_depth?: number;
        spool_oldest_at?: string;
        hooks_ok?: boolean;
        otel_ok?: boolean;
        bundle_etag?: string;
      }
    | undefined,
  now: Date,
  ingest: boolean,
): Promise<void> {
  const values: Record<string, unknown> = {
    lastSeenAt: now,
    lastHeartbeatAt: now,
    updatedAt: now,
    ...(ingest ? { lastIngestAt: now } : {}),
  };
  if (daemon?.version !== undefined) values["daemonVersion"] = daemon.version;
  if (daemon?.uptime_s !== undefined) values["daemonUptimeS"] = daemon.uptime_s;
  if (daemon?.spool_depth !== undefined)
    values["spoolDepth"] = daemon.spool_depth;
  if (daemon?.spool_oldest_at !== undefined)
    values["spoolOldestAt"] = new Date(daemon.spool_oldest_at);
  if (daemon?.hooks_ok !== undefined) {
    values["hooksOk"] = daemon.hooks_ok;
    values["hooksLastCheckedAt"] = now;
  }
  if (daemon?.otel_ok !== undefined) values["otelOk"] = daemon.otel_ok;
  if (daemon?.bundle_etag !== undefined)
    values["bundleEtagServed"] = daemon.bundle_etag;
  await tx
    .update(schema.tachoHosts)
    .set(values)
    .where(eq(schema.tachoHosts.id, host.id));
}

/** `sql` re-export so handlers can express counter increments without importing drizzle themselves. */
export const increment = (column: unknown, by: number) =>
  sql`${column} + ${by}`;
