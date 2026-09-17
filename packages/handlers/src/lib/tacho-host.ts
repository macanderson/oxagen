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
import { gatewayMandateTools } from "@oxagen/iam/machine-key-scope";
import {
  BUNDLE_FEATURE_GATEWAY_TOOLS,
  digestJcs,
  type JsonValue,
} from "@oxagen/tacho";
import { schema } from "@oxagen/database";
import { RETENTION_CONTENT_CLASSES } from "@oxagen/run-ledger";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import { type BundleSigner, bundleSignerFromEnv } from "./tacho-bundle-signing";
import { tachoHostApiKeyScopeSchema } from "./tacho-enrollment";

export type TachoHostRow = typeof schema.tachoHosts.$inferSelect;
export type ControlEnvelope = z.output<typeof controlEnvelopeSchema>;

/** The transaction shape the helpers need; kept narrow so tests can fake it. */
interface TachoTx {
  query: {
    apiKeys: { findFirst: (args: unknown) => Promise<unknown> };
    tachoHosts: { findFirst: (args: unknown) => Promise<unknown> };
    authorizationDenyGenerations: {
      findMany: (args: unknown) => Promise<unknown>;
    };
    tachoControlCommands: { findMany: (args: unknown) => Promise<unknown> };
    retentionPolicyVersions: { findFirst: (args: unknown) => Promise<unknown> };
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

/** The bundle's retention clause: what the host may retain and ship. */
type BundleRetention = PolicyBundle["retention"];

/**
 * The workspace's fidelity setting (ADR-058 decision 2): the mode and content
 * classes of its latest `evidence.retention_policy_versions` row. A workspace
 * that has pinned no policy retains bodies of every class; `digest_only` is
 * the opt-down a policy row records, and every run in that workspace grades
 * `inspect`.
 */
export async function readWorkspaceRetention(
  tx: TachoTx,
  orgId: string,
  workspaceId: string,
): Promise<BundleRetention> {
  const row = (await tx.query.retentionPolicyVersions.findFirst({
    where: and(
      eq(schema.retentionPolicyVersions.orgId, orgId),
      eq(schema.retentionPolicyVersions.workspaceId, workspaceId),
    ),
    orderBy: [desc(schema.retentionPolicyVersions.version)],
    columns: { mode: true, retainedContentClasses: true },
  })) as { mode: string; retainedContentClasses: string[] } | undefined;
  if (!row) {
    return { mode: "content_exact", classes: [...RETENTION_CONTENT_CLASSES] };
  }
  if (row.mode === "digest_only") return { mode: "digest_only", classes: [] };
  return { mode: "content_exact", classes: [...row.retainedContentClasses] };
}

/** The unsigned bundle for a host at this moment (spec section 7.1). */
/**
 * The gateway mandate, materialised for the host that has to serve it
 * (ADR-078 §4).
 *
 * `gatewayMayInvoke` is a rule over the capability registry, and only the
 * control plane can evaluate it: `@oxagen/tacho` takes no `@oxagen/*` runtime
 * dependency, so the local MCP gateway cannot read a capability's surfaces,
 * mutation or sensitivity. Without the answer on the wire the gateway
 * advertised the whole workspace toolbelt and left the mandate to refuse a
 * tool only once it was selected — showing a connected app tools that could
 * only fail, and counting forbidden tools against `tool_ceiling`.
 *
 * **Emitted empty when the mandate is empty; omitted only when there is no
 * mandate to state.** These are not the same condition and must not share an
 * encoding. A populated registry whose permitted set is empty — a policy
 * change that leaves only mutating or high-sensitivity MCP tools — is a
 * decision, and `gateway_tools: []` states it: the gateway serves nothing.
 * An empty registry is a process that has not imported its contracts, which
 * is not a decision about anything, and there the field is omitted.
 * `gatewayMandateTools` returns `undefined` for exactly that case and a list
 * (possibly empty) otherwise, so the two cannot be conflated here.
 *
 * Omitting for an empty permitted set would be a fail-open: absent means *not
 * told* on this wire, and a gateway that is not told serves the upstream
 * `tools/list` unfiltered (`mcp-gateway.ts`, `gatewayToolsOf`). "Permits
 * nothing" collapsing into "serve everything" is the failure this field
 * exists to prevent. Absent stays reserved for a bundle signed by a control
 * plane that had nothing to say, which is also what a bundle from before this
 * field means.
 *
 * **Phase 1 of two: emitted only to a host that said it can parse it.**
 * `policyBundleSchema` is `.strict()` on the host, so a daemon or CLI built
 * before this field rejects the *whole* mandate the moment a bundle carries
 * one. The control plane deploys before the fleet upgrades, so emitting it to
 * everyone would fail every bundle refresh on every installed host — stranding
 * each on a stale mandate — and would stop an un-upgraded CLI enrolling at
 * all, since enrollment parses a bundle too. So the host advertises
 * `BUNDLE_FEATURE_GATEWAY_TOOLS` (`hosts.bundle_features`, written at
 * enrollment and refreshed from every control poll) and only then is it sent.
 *
 * **The gate is a compatibility constraint, not a change of mind about the
 * control.** An unfiltered `tools/list` is a security hole — it offers a
 * connected app tools the mandate forbids — and a host that has not
 * advertised keeps that hole until it upgrades. That is the cost of not
 * breaking it outright, and it is bounded by the fleet upgrading. Phase 2
 * makes the field required in `policyBundleSchema` and deletes this gate, so
 * absent stops being representable. Until then: do not widen this to every
 * host, and do not delete it as dead weight.
 */
function gatewayTools(host: TachoHostRow): { gateway_tools?: string[] } {
  if (!parsesGatewayTools(host)) return {};
  const tools = gatewayMandateTools();
  // `undefined` only — an empty list is a mandate and goes on the wire.
  return tools === undefined ? {} : { gateway_tools: tools };
}

/** Whether this host named `gateway_tools` among the fields it can parse. */
function parsesGatewayTools(host: TachoHostRow): boolean {
  const advertised: unknown = host.bundleFeatures;
  return (
    Array.isArray(advertised) &&
    advertised.includes(BUNDLE_FEATURE_GATEWAY_TOOLS)
  );
}

export function unsignedBundle(
  host: TachoHostRow,
  denyGeneration: DenyGeneration,
  retention: BundleRetention,
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
    retention,
    mode,
    ...gatewayTools(host),
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

/**
 * Expire this host's `queued` commands whose expiry passed before a poll
 * drained them (spec §7.4 `expired`: "the expiry passed with no boundary
 * reached"). Runs on every control poll.
 *
 * Only `queued` rows are swept: a row is Oxagen's until it leaves on the
 * wire, and the host's after. The host checks the deadline at receipt and
 * again at the boundary that would inject a steer, acknowledging `expired`
 * when it passed, so every acknowledgement it sends is true of the chain,
 * and it may arrive after the clock passed (a pause applied at receipt is
 * acknowledged on the next poll; an ingest in between must not turn that
 * row `expired` and make `fetch_commands` drop the `applied`).
 * `list_commands` derives `expired` under this same predicate and no wider;
 * a row the host holds and never acknowledges reads as recorded, with its
 * `expiresAt` for the interface to show.
 */
export async function expireCommands(
  tx: TachoTx,
  host: TachoHostRow,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.tachoControlCommands)
    .set({ outcome: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.tachoControlCommands.hostId, host.id),
        eq(schema.tachoControlCommands.outcome, "queued"),
        lte(schema.tachoControlCommands.expiresAt, now),
      ),
    );
}

type ControlCommandRow = typeof schema.tachoControlCommands.$inferSelect;
type DeliveredCommand = ControlEnvelope["commands"][number];

/** A queued row as the wire carries it (spec section 7.4). */
function toDeliveredCommand(row: ControlCommandRow): DeliveredCommand {
  const payload = (row.payload as Record<string, unknown>) ?? {};
  return {
    id: row.publicId,
    command: row.command as DeliveredCommand["command"],
    session_uuid:
      typeof payload["session_uuid"] === "string"
        ? (payload["session_uuid"] as string)
        : null,
    payload,
    requested_mode: row.requestedMode as DeliveredCommand["requested_mode"],
    delivery_mode: row.deliveryMode as DeliveredCommand["delivery_mode"],
    degraded_reason: row.degradedReason,
    reason: row.reason,
    issued_at: row.issuedAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}

/** Queued commands for a host, marked `sent` as they leave. */
export async function drainCommands(
  tx: TachoTx,
  host: TachoHostRow,
  now: Date = new Date(),
): Promise<ControlEnvelope["commands"]> {
  await expireCommands(tx, host, now);
  const rows = (await tx.query.tachoControlCommands.findMany({
    where: and(
      eq(schema.tachoControlCommands.hostId, host.id),
      eq(schema.tachoControlCommands.outcome, "queued"),
      or(
        isNull(schema.tachoControlCommands.expiresAt),
        gt(schema.tachoControlCommands.expiresAt, now),
      ),
    ),
    // `issued_at` alone is a partial order: `defaultNow()` is the transaction
    // timestamp, so two commands dispatched in the same instant tie and the
    // host then receives them in whatever order the heap hands back — a pause
    // arriving after the steer the operator issued second. The public id is
    // the tie-break `list_commands` already uses, so the delivery order and
    // the delivery report agree on one total order rather than two partial
    // ones.
    orderBy: [
      asc(schema.tachoControlCommands.issuedAt),
      asc(schema.tachoControlCommands.publicId),
    ],
    limit: 100,
  })) as ControlCommandRow[];
  if (rows.length > 0) {
    await tx
      .update(schema.tachoControlCommands)
      .set({ outcome: "sent", deliveredAt: now, updatedAt: now })
      .where(
        inArray(
          schema.tachoControlCommands.id,
          rows.map((row) => row.id),
        ),
      );
  }
  return rows.map(toDeliveredCommand);
}

/** The control envelope every machine response carries (spec section 7.4). */
export async function controlEnvelope(
  tx: TachoTx,
  ctx: CapabilityContext,
  host: TachoHostRow,
  now: Date = new Date(),
): Promise<ControlEnvelope> {
  const [denyGeneration, retention] = await Promise.all([
    readDenyGeneration(tx, ctx.orgId, ctx.workspaceId),
    readWorkspaceRetention(tx, ctx.orgId, ctx.workspaceId),
  ]);
  const bundle = unsignedBundle(host, denyGeneration, retention, now);
  const commands = await drainCommands(tx, host, now);
  return controlEnvelopeSchema.parse({
    host_status: tachoHostStatusSchema.parse(host.status),
    deny_generation: denyGeneration,
    bundle_etag: bundle.etag,
    commands,
  });
}

/**
 * Touch the host's liveness columns from what the daemon reported.
 *
 * `bundle_features` is here rather than only at enrollment because it has to
 * track the code the host is **running**. `wrapper_version` and
 * `daemon_version` both originate in `host.json`, which `tacho enroll` writes
 * once and no upgrade rewrites, so a host that upgrades in place keeps
 * reporting the version it enrolled with forever — which would leave every
 * upgraded host permanently ungated. The advertisement rides the health
 * report on every poll instead, so an upgraded host is gated in on its next
 * one.
 *
 * **It tracks downgrades too, which is why a health report without
 * `bundle_features` clears the column rather than preserving it.** The
 * advertisement is a statement about the parser now running, and the wire
 * contract makes absence mean *this parser predates the field* — a daemon new
 * enough to name a feature always names it (`daemon.ts` sends the full
 * `TACHO_BUNDLE_FEATURES` on every poll). So the two cases are read apart:
 *
 *   - **no `daemon` object at all** — the poll reported no health, so there is
 *     nothing to learn and the stored advertisement stands;
 *   - **a `daemon` object without `bundle_features`** — the host reported its
 *     health and named no features, so the stored support is stale and is
 *     cleared to `[]`.
 *
 * Preserving the stale value is what breaks a rollback. An enrollment by a
 * current CLI, or a feature poll that landed before a downgrade, leaves
 * `gateway_tools` on the column; the control envelope then keeps publishing
 * the etag of a bundle carrying that field, and the rolled-back host's
 * `.strict()` parser rejects every refresh — stranded on a stale mandate,
 * refetching forever, with no poll that can ever talk it back down. Clearing
 * costs an upgraded host nothing, because it re-advertises on its very next
 * poll.
 */
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
        bundle_features?: string[];
      }
    | undefined,
  now: Date,
  ingest: boolean,
): Promise<TachoHostRow> {
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
  // Reported health with no features named is a downgrade, not a silence:
  // clear the stale support. Only a poll with no health report at all leaves
  // the stored advertisement alone.
  if (daemon !== undefined)
    values["bundleFeatures"] = daemon.bundle_features ?? [];
  if (daemon?.bundle_etag !== undefined)
    values["bundleEtagServed"] = daemon.bundle_etag;
  await tx
    .update(schema.tachoHosts)
    .set(values)
    .where(eq(schema.tachoHosts.id, host.id));
  // The caller builds this poll's control envelope from the host it holds, and
  // `bundleFeatures` decides which mandate that envelope carries. Persisting
  // the advertisement without handing it back would leave the first poll after
  // an upgrade computing its bundle — and its etag — from the features the host
  // had BEFORE it upgraded, so an upgraded daemon would keep serving the
  // unfiltered tool list until some later poll.
  return { ...host, ...values } as TachoHostRow;
}

/** `sql` re-export so handlers can express counter increments without importing drizzle themselves. */
export const increment = (column: unknown, by: number) =>
  sql`${column} + ${by}`;
