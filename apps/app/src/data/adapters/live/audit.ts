// The live audit adapter (Batch 3 lane A10: audit + shell): Audit events,
// incidents, exports, erasure and retention, and the shell's notifications.
//
// Reads that exist as agent tools go through the kernel as the signed-in person
// (query_audit_log, get_evidence_retention, list_notifications), so IAM decides
// and audits them exactly as on the API. The stores no agent tool lists
// (tacho.incidents, privacy.privacy_erasure_requests,
// privacy.privacy_export_requests, auth.users and iam.principals for names) are
// read with withTenantDb inside runInTenantScope, so RLS scopes them, and only
// for a viewer whose organization role may audit. The IAM decision rows in
// ClickHouse audit_events are read through chSelect (org_id-filtered, on the
// organization's data plane) to tell an agent or a service from the person
// whose session carried the call, and to name what the call acted on.
//
// Every result is parsed through its view model before it leaves. A row the
// view model refuses only where the store records nothing (UNRECORDED_PATHS in
// ./mappers/audit.ts) keeps the method not-backed; a refusal anywhere else is a
// mapping bug, reported and returned as an error. An empty store is a recorded
// fact and serves live. Receipts, holds and keys (G8) and assurance history (M2)
// have no store at all.
import "server-only";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { notBackedFor } from "@/data/backing";
import {
  ArchiveExport,
  AuditEvent,
  ErasureRequest,
  Incident,
  Notification,
  RetentionTier,
} from "@/data/contracts";
import { denied, type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { AuditReadPort, ShellReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { liveTenancyLookups } from "@/server/tenancy-lookups";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  type DecisionRow,
  type ErasureRow,
  type ExportRow,
  type IncidentRow,
  type ResolvedPrincipal,
  type SecurityEventSource,
  toArchiveExport,
  toAuditEvent,
  toErasureRequest,
  toIncident,
  toNotification,
  toRetentionTiers,
  UNRECORDED_PATHS,
} from "./mappers/audit";

/** The newest control-plane events one read returns (query_audit_log's page cap). */
export const EVENTS_LIMIT = 200;
/** The newest incidents, erasure and export requests one read returns. */
export const ROWS_LIMIT = 500;
/** The newest notifications the bell reads (list_notifications' cap is 100). */
export const NOTIFICATIONS_LIMIT = 50;

/**
 * Organization roles that may read the audit stores no agent tool guards.
 * `compliance` is the auditor role; owner and admin run the organization.
 */
export const AUDIT_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "compliance",
]);

const AUDIT = PAGE_FAILURES.audit;
const SHELL = PAGE_FAILURES.shell;
/** The mapped value broke its view model on a recorded path: never hand the page a shape it did not promise. */
const MISMATCH = readError("contract_output_mismatch", 502);

/** What the live audit adapter reads. `liveAuditStores` is the real one. */
export type AuditStores = {
  /** The signed-in person's user id, or null without a session. */
  viewerId(): Promise<string | null>;
  /** The viewer's organization role, lowercased; null for a non-member. */
  orgRole(scope: Scope, userId: string): Promise<string | null>;
  /** An agent tool read as the viewer, parsed with the tool's own output schema. */
  readTool<O>(
    scope: Scope,
    userId: string,
    contract: ToolContract<unknown, O>,
    input: unknown,
    permission: string,
  ): Promise<Read<O>>;
  /** ClickHouse audit_events decisions for these invocations, principals resolved. */
  decisions(
    scope: Scope,
    keys: readonly { requestId: string; capability: string }[],
  ): Promise<DecisionRow[]>;
  /** `auth.users.public_id` keyed by user id. */
  userPublicIds(
    scope: Scope,
    userIds: readonly string[],
  ): Promise<Map<string, string>>;
  /** The scope's workspace, or every workspace of the organization. */
  workspaceIds(scope: Scope): Promise<string[]>;
  /** One workspace's incidents, newest first. */
  incidents(scope: Scope): Promise<IncidentRow[]>;
  erasureRequests(scope: Scope): Promise<ErasureRow[]>;
  exportRequests(scope: Scope): Promise<ExportRow[]>;
};

/** The view models each method parses through. Tests pass the promoted ones. */
export type AuditViews = {
  AuditEvent: z.ZodType<AuditEvent>;
  Incident: z.ZodType<Incident>;
  ArchiveExport: z.ZodType<ArchiveExport>;
  ErasureRequest: z.ZodType<ErasureRequest>;
  RetentionTier: z.ZodType<RetentionTier>;
  Notification: z.ZodType<Notification>;
};

export const CONTRACT_VIEWS: AuditViews = {
  AuditEvent,
  Incident,
  ArchiveExport,
  ErasureRequest,
  RetentionTier,
  Notification,
};

export type LiveAuditDeps = {
  stores: AuditStores;
  views?: AuditViews;
  /** Where a store failure or a mapping bug is reported. */
  report?: (error: unknown, context: string) => void;
};

type SettledMethod = keyof typeof UNRECORDED_PATHS;

/** A view-model refusal on a path the store does record: a mapping bug. */
export class AuditContractMismatch extends Error {
  readonly code = "audit_contract_mismatch";
  constructor(
    readonly method: SettledMethod,
    readonly paths: readonly string[],
  ) {
    super(`${method} rows do not fit their view model at: ${paths.join(", ")}`);
    this.name = "AuditContractMismatch";
  }
}

const UUID = z.uuid();

export function createLiveAudit({
  stores,
  views = CONTRACT_VIEWS,
  report = () => undefined,
}: LiveAuditDeps): {
  audit: AuditReadPort;
  notifications: ShellReadPort["notifications"];
} {
  /**
   * Parse rows through a view model: live when they fit, not-backed when they
   * miss only what the store does not record, an error on anything else.
   */
  function settle<T>(
    method: SettledMethod,
    notBackedValue: () => Read<T[]>,
    view: z.ZodType<T>,
    rows: readonly unknown[],
  ): Read<T[]> {
    const parsed = z.array(view).safeParse(rows);
    if (parsed.success) return readOk(parsed.data);
    const unrecorded = new Set<string>(UNRECORDED_PATHS[method]);
    const paths = [
      ...new Set(
        parsed.error.issues.map((issue) =>
          issue.path.filter((p) => typeof p === "string").join("."),
        ),
      ),
    ];
    const mismatched = paths.filter((p) => !unrecorded.has(p));
    if (mismatched.length > 0) {
      report(new AuditContractMismatch(method, mismatched), `audit.${method}`);
      return MISMATCH;
    }
    return notBackedValue();
  }

  /** A store failure is the page's named error, reported once. */
  async function guarded<T>(
    context: string,
    failure: { code: string; status: number },
    read: () => Promise<Read<T>>,
  ): Promise<Read<T>> {
    try {
      return await read();
    } catch (error) {
      report(error, context);
      return readError(failure.code, failure.status);
    }
  }

  /** The viewer, when their organization role may read the unguarded audit stores. */
  async function auditor(scope: Scope): Promise<Read<string>> {
    const userId = await stores.viewerId();
    if (!userId) return denied(AUDIT.permission);
    const role = await stores.orgRole(scope, userId);
    return role !== null && AUDIT_ROLES.has(role)
      ? readOk(userId)
      : denied(AUDIT.permission);
  }

  const audit: AuditReadPort = {
    events: (scope) =>
      guarded("audit.events", AUDIT.error, async () => {
        const userId = await stores.viewerId();
        if (!userId) return denied(AUDIT.permission);
        const feed = await stores.readTool(
          scope,
          userId,
          auditLogQuery,
          { source: "all", limit: EVENTS_LIMIT, offset: 0 },
          AUDIT.permission,
        );
        if (!feed.ok) return feed;
        const events = feed.value.events;

        const keys = events.flatMap((e) =>
          e.requestId && e.capability && UUID.safeParse(e.requestId).success
            ? [{ requestId: e.requestId, capability: e.capability }]
            : [],
        );
        const actorIds = [
          ...new Set(
            events.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])),
          ),
        ];
        const [decisions, users] = await Promise.all([
          keys.length === 0 ? [] : stores.decisions(scope, keys),
          actorIds.length === 0
            ? new Map<string, string>()
            : stores.userPublicIds(scope, actorIds),
        ]);
        const byInvocation = new Map(
          decisions.map((d) => [`${d.requestId}:${d.capability}`, d]),
        );
        const sources = events.map(
          (event): SecurityEventSource => ({
            event,
            actorPublicId: event.actorUserId
              ? (users.get(event.actorUserId) ?? null)
              : null,
            decision:
              event.requestId && event.capability
                ? (byInvocation.get(`${event.requestId}:${event.capability}`) ??
                  null)
                : null,
          }),
        );
        return settle(
          "events",
          () => notBackedFor("audit", "events"),
          views.AuditEvent,
          sources.map(toAuditEvent),
        );
      }),

    incidents: (scope) =>
      guarded("audit.incidents", AUDIT.error, async () => {
        const viewer = await auditor(scope);
        if (!viewer.ok) return viewer;
        const workspaceIds = await stores.workspaceIds(scope);
        const perWorkspace = await Promise.all(
          workspaceIds.map((workspaceId) =>
            stores.incidents({ orgId: scope.orgId, workspaceId }),
          ),
        );
        const rows = perWorkspace
          .flat()
          .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
          .slice(0, ROWS_LIMIT);
        return settle(
          "incidents",
          () => notBackedFor("audit", "incidents"),
          views.Incident,
          rows.map(toIncident),
        );
      }),

    // G8: receipt frames, audit.legal_holds and per-organization KEKs have no store.
    receipts: () => Promise.resolve(notBackedFor("audit", "receipts")),
    getReceipt: () => Promise.resolve(notBackedFor("audit", "getReceipt")),
    holds: () => Promise.resolve(notBackedFor("audit", "holds")),

    exports: (scope) =>
      guarded("audit.exports", AUDIT.error, async () => {
        const viewer = await auditor(scope);
        if (!viewer.ok) return viewer;
        const rows = await stores.exportRequests(scope);
        return settle(
          "exports",
          () => notBackedFor("audit", "exports"),
          views.ArchiveExport,
          rows.map(toArchiveExport),
        );
      }),

    keys: () => Promise.resolve(notBackedFor("audit", "keys")),

    erasure: (scope) =>
      guarded("audit.erasure", AUDIT.error, async () => {
        const viewer = await auditor(scope);
        if (!viewer.ok) return viewer;
        const rows = await stores.erasureRequests(scope);
        return settle(
          "erasure",
          () => notBackedFor("audit", "erasure"),
          views.ErasureRequest,
          rows.map(toErasureRequest),
        );
      }),

    retention: (scope) =>
      guarded("audit.retention", AUDIT.error, async () => {
        const userId = await stores.viewerId();
        if (!userId) return denied(AUDIT.permission);
        const posture = await stores.readTool(
          scope,
          userId,
          billingEvidenceRetention,
          {},
          AUDIT.permission,
        );
        if (!posture.ok) return posture;
        return settle(
          "retention",
          () => notBackedFor("audit", "retention"),
          views.RetentionTier,
          toRetentionTiers(posture.value),
        );
      }),

    // M2: the assurance suite has not run anywhere yet.
    assuranceHistory: () =>
      Promise.resolve(notBackedFor("audit", "assuranceHistory")),
  };

  const notifications: ShellReadPort["notifications"] = (scope) =>
    guarded("shell.notifications", SHELL.error, async () => {
      const userId = await stores.viewerId();
      if (!userId) return denied(SHELL.permission);
      const feed = await stores.readTool(
        scope,
        userId,
        notificationsList,
        { unreadOnly: false, limit: NOTIFICATIONS_LIMIT },
        SHELL.permission,
      );
      if (!feed.ok) return feed;
      return settle(
        "notifications",
        () => notBackedFor("shell", "notifications"),
        views.Notification,
        feed.value.notifications.map(toNotification),
      );
    });

  return { audit, notifications };
}

// ---- The real stores -------------------------------------------------------------

function inTenant<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runInTenantScope(scope, () => withTenantDb(fn));
}

/** Kernel codes that mean "this person may not read it", not "it failed". */
const DENIED_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
]);

/**
 * query_audit_log refuses a workspace-scoped caller the org-wide feed with a
 * plain `Forbidden:` error from inside the handler, not a kernel denial.
 */
function isDenial(error: unknown): boolean {
  if (error instanceof CapabilityError) return DENIED_CODES.has(error.code);
  return error instanceof Error && error.message.startsWith("Forbidden:");
}

let handlersRegistered: Promise<unknown> | null = null;

function registerHandlers(): Promise<unknown> {
  handlersRegistered ??= import("@oxagen/handlers/register");
  return handlersRegistered;
}

async function resolvePrincipals(
  scope: Scope,
  principalIds: readonly string[],
): Promise<Map<string, ResolvedPrincipal>> {
  const resolved = new Map<string, ResolvedPrincipal>();
  if (principalIds.length === 0) return resolved;
  await inTenant(scope, async (tx) => {
    const p = schema.principals;
    const rows = await tx
      .select({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        parentUserId: p.parentUserId,
      })
      .from(p)
      .where(and(eq(p.orgId, scope.orgId), inArray(p.id, [...principalIds])));
    if (rows.length === 0) return;

    const userIds = rows.flatMap((r) =>
      r.kind === "human" && r.parentUserId ? [r.parentUserId] : [],
    );
    const agentPrincipalIds = rows.flatMap((r) =>
      r.kind === "agent" ? [r.id] : [],
    );
    const [users, agents] = await Promise.all([
      userIds.length === 0
        ? []
        : tx
            .select({ id: schema.users.id, publicId: schema.users.publicId })
            .from(schema.users)
            .where(inArray(schema.users.id, userIds)),
      agentPrincipalIds.length === 0
        ? []
        : tx
            .select({
              principalId: schema.agents.principalId,
              slug: schema.agents.slug,
              workspaceNamespace: schema.workspaces.namespace,
              orgNamespace: schema.organizations.namespace,
            })
            .from(schema.agents)
            .innerJoin(
              schema.workspaces,
              eq(schema.workspaces.id, schema.agents.workspaceId),
            )
            .innerJoin(
              schema.organizations,
              eq(schema.organizations.id, schema.agents.orgId),
            )
            .where(inArray(schema.agents.principalId, agentPrincipalIds)),
    ]);
    const userPublicId = new Map(users.map((u) => [u.id, u.publicId]));
    const agentKey = new Map(
      agents.flatMap((a) =>
        a.principalId
          ? [
              [
                a.principalId,
                `${a.orgNamespace}.${a.workspaceNamespace}.${a.slug}`,
              ] as const,
            ]
          : [],
      ),
    );
    for (const r of rows) {
      resolved.set(r.id, {
        kind: r.kind,
        displayName: r.displayName,
        // An agent's parent user is its operator, not who acted.
        userPublicId:
          r.kind === "human" && r.parentUserId
            ? (userPublicId.get(r.parentUserId) ?? null)
            : null,
        agentKey: agentKey.get(r.id) ?? null,
      });
    }
  });
  return resolved;
}

/**
 * The JSON format returns UUIDs as strings and an Enum8 as its label. No
 * `toString(x) AS x` in the query: ClickHouse resolves an alias inside WHERE,
 * so a String alias of request_id would never match the Array(UUID) filter.
 */
type DecisionWire = {
  request_id: string;
  capability: string;
  acting_principal_id: string;
  acting_principal_kind: "human" | "agent" | "service";
  target_kind: string | null;
  target_id: string | null;
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const liveAuditStores: AuditStores = {
  async viewerId() {
    const session = await getSession();
    return session?.user.id ?? null;
  },

  orgRole: (scope, userId) => liveTenancyLookups.orgRole(scope.orgId, userId),

  async readTool(scope, userId, contract, input, permission) {
    await registerHandlers();
    if (!getCapability(contract.name))
      throw new Error(`agent tool not registered: ${contract.name}`);
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    };
    let raw: unknown;
    try {
      raw = await runInTenantScope(scope, () =>
        invoke(contract.name, input, ctx),
      );
    } catch (error) {
      if (isDenial(error)) return denied(permission);
      throw error;
    }
    const parsed = contract.output.safeParse(raw);
    return parsed.success ? readOk(parsed.data) : MISMATCH;
  },

  async decisions(scope, keys) {
    const requestIds = [...new Set(keys.map((k) => k.requestId))];
    if (requestIds.length === 0) return [];
    const { chSelect } = await import("@oxagen/telemetry");
    const result = await runInTenantScope(scope, () =>
      chSelect<DecisionWire>({
        query: `
          SELECT
            request_id,
            capability,
            acting_principal_id,
            acting_principal_kind,
            target_kind,
            target_id
          FROM audit_events FINAL
          WHERE org_id = {orgId:UUID}
            AND request_id IN {requestIds:Array(UUID)}
          ORDER BY occurred_at DESC
          LIMIT 1 BY request_id, capability
        `,
        params: { requestIds },
      }),
    );
    const wanted = new Set(keys.map((k) => `${k.requestId}:${k.capability}`));
    const rows = result.data.filter((r) =>
      wanted.has(`${r.request_id}:${r.capability}`),
    );
    const principals = await resolvePrincipals(scope, [
      ...new Set(
        rows.flatMap((r) =>
          r.acting_principal_id === NIL_UUID ? [] : [r.acting_principal_id],
        ),
      ),
    ]);
    return rows.map(
      (r): DecisionRow => ({
        requestId: r.request_id,
        capability: r.capability,
        actingPrincipalKind:
          r.acting_principal_id === NIL_UUID ? null : r.acting_principal_kind,
        targetKind: r.target_kind,
        targetId: r.target_id,
        principal: principals.get(r.acting_principal_id) ?? null,
      }),
    );
  },

  async userPublicIds(scope, userIds) {
    const rows = await inTenant(scope, (tx) =>
      tx
        .select({ id: schema.users.id, publicId: schema.users.publicId })
        .from(schema.users)
        .where(inArray(schema.users.id, [...userIds])),
    );
    return new Map(rows.map((r) => [r.id, r.publicId]));
  },

  async workspaceIds(scope) {
    if (!isOrgOnlyScope(scope)) return [scope.workspaceId];
    const rows = await inTenant(scope, (tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, scope.orgId)),
    );
    return rows.map((r) => r.id);
  },

  incidents: (scope) =>
    inTenant(scope, async (tx) => {
      const t = schema.tachoIncidents;
      const rows = await tx
        .select({
          publicId: t.publicId,
          kind: t.kind,
          severity: t.severity,
          detectedAt: t.detectedAt,
          detectedBy: t.detectedBy,
          resolvedAt: t.resolvedAt,
          resolutionNote: t.resolutionNote,
          hostAgentKey: schema.tachoHosts.agentKey,
          hostname: schema.tachoHosts.hostname,
          sessionAgentKey: schema.tachoSessions.agentKey,
          sessionPublicId: schema.tachoSessions.publicId,
          resolvedByPublicId: schema.principals.publicId,
        })
        .from(t)
        .leftJoin(schema.tachoHosts, eq(schema.tachoHosts.id, t.hostId))
        .leftJoin(
          schema.tachoSessions,
          eq(schema.tachoSessions.id, t.sessionId),
        )
        .leftJoin(
          schema.principals,
          eq(schema.principals.id, t.resolvedByPrincipalId),
        )
        .where(
          and(eq(t.orgId, scope.orgId), eq(t.workspaceId, scope.workspaceId)),
        )
        .orderBy(desc(t.detectedAt))
        .limit(ROWS_LIMIT);
      return rows.map(
        ({ hostAgentKey, sessionAgentKey, ...row }): IncidentRow => ({
          ...row,
          agentKey: hostAgentKey ?? sessionAgentKey,
        }),
      );
    }),

  erasureRequests: (scope) =>
    inTenant(scope, async (tx) => {
      const e = schema.privacyErasureRequests;
      const rows = await tx
        .select({
          publicId: e.publicId,
          scope: e.scope,
          status: e.status,
          createdAt: e.createdAt,
          scheduledAt: e.scheduledAt,
          completedAt: e.completedAt,
          errorMessage: e.errorMessage,
          requesterPublicId: schema.users.publicId,
          orgPublicId: schema.organizations.publicId,
        })
        .from(e)
        .leftJoin(schema.users, eq(schema.users.id, e.userId))
        .leftJoin(schema.organizations, eq(schema.organizations.id, e.orgId))
        .where(eq(e.orgId, scope.orgId))
        .orderBy(desc(e.createdAt))
        .limit(ROWS_LIMIT);
      return rows;
    }),

  exportRequests: (scope) =>
    inTenant(scope, (tx) => {
      const x = schema.privacyExportRequests;
      return tx
        .select({
          publicId: x.publicId,
          scope: x.scope,
          status: x.status,
          createdAt: x.createdAt,
          requesterPublicId: schema.users.publicId,
        })
        .from(x)
        .leftJoin(schema.users, eq(schema.users.id, x.userId))
        .where(eq(x.orgId, scope.orgId))
        .orderBy(desc(x.createdAt))
        .limit(ROWS_LIMIT);
    }),
};

/** Report to the ClickHouse error stream; telemetry loads lazily. */
async function reportToTelemetry(error: unknown, context: string) {
  try {
    const { captureError } = await import("@oxagen/telemetry");
    captureError({ error, source: "app", severity: "error", context });
  } catch {
    // Error capture must never become a new failure inside a read.
  }
}

const live = createLiveAudit({
  stores: liveAuditStores,
  report: (error, context) => void reportToTelemetry(error, context),
});

export const liveAudit: AuditReadPort = live.audit;

/** The shell's notification bell. Registered on the shell port in ./index.ts. */
export const liveNotifications: ShellReadPort["notifications"] =
  live.notifications;
