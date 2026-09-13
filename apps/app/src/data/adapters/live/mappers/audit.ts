// Recorded rows → the Audit view models, and the shell's notifications (spec
// vocabulary). Pure: no I/O.
//
// Each mapper takes what the live audit adapter read — the outputs of the agent
// tools it invoked (query_audit_log, list_notifications, get_evidence_retention)
// and drizzle rows for the stores no agent tool lists (tacho.incidents,
// privacy.privacy_erasure_requests, privacy.privacy_export_requests, the IAM
// decision rows in ClickHouse audit_events) — and returns the view model with
// every field the stores do not record set to null. Never a zero, an empty
// string, a guessed severity or a guessed enum standing in for "not recorded".
//
// Column-level mapping (✅ recorded · ∅ not recorded, null):
//
//   AuditEvent  ← security.security_events via query_audit_log, joined by
//                 request_id + capability to ClickHouse audit_events
//     at        ✅ occurred_at
//     kind      ✅ event_type (`auth.sign_in`, `capability.invoke_allowed`, …)
//     actor     ✅ audit_events.acting_principal_kind/id → an agent key or a
//                 service principal's name; else actor_user_id → auth.users.public_id;
//                 ∅ when neither resolves (a failed sign-in with an unknown email)
//     summary   ∅ no prose is recorded; the page words the kind from its catalog
//     severity  ∅ security_events has no severity column (spec A.9 adds one)
//     ref       ✅ audit_events.target_id when the join finds one, else ∅
//
//   Incident    ← tacho.incidents (+ tacho.hosts, tacho.sessions, iam.principals)
//     id, severity, at, detectedBy, status, closedAt  ✅ public_id, severity,
//                 detected_at, detected_by, resolved_at
//     kind      ✅ kind, but eight of the twelve collector kinds are outside
//                 the spec's IncidentKind
//     agentKey  ✅ tacho.hosts.agent_key ?? tacho.sessions.agent_key
//     runIds    ✅ tacho.sessions.public_id
//     scope     ✅ tacho.hosts.hostname ?? the agent key; ∅ for neither
//     title, detail  ∅ the collector records a kind and evidence, no prose
//     resolution     ✅ resolution_note, ∅ while open
//     ownerId, dueOn ∅ no owner or due date is recorded
//     closedBy  ✅ resolved_by_principal_id → iam.principals.public_id
//
//   ErasureRequest ← privacy.privacy_erasure_requests
//     id ✅ public_id · requestedAt ✅ created_at · dueAt ✅ scheduled_at ·
//     effectiveAt ✅ completed_at · scope ✅ scope · note ✅ error_message
//     subject     ✅ user scope: user_id → auth.users.public_id; org scope: the org's public id
//     requestedById ✅ user_id → auth.users.public_id (the handler stamps the requester)
//     status      queued|processing → pending; completed and failed have no
//                 spec status (today's erasure is a hard delete, not a key
//                 destruction, so `keys_destroyed` would claim what did not happen) ∅
//     holdId      ∅ there is no legal-hold store (G8)
//
//   ArchiveExport ← privacy.privacy_export_requests
//     id ✅ public_id · createdAt ✅ created_at · createdById ✅ user_id → auth.users.public_id
//     status      queued|processing → building, ready → ready, failed ∅
//     description, from, to, contents, size, keys ∅ not recorded
//     signature   ∅ the bundle is an unsigned blob URL
//
//   RetentionTier ← get_evidence_retention (evidence.retention_policy_versions)
//     tier      ✅ `bodies`: the policies' ttl_days is the exact-payload window
//     retention ✅ effectiveRetentionDays as an ISO 8601 duration, ∅ before a policy is pinned
//     volume    ✅ storedGbBeyondIncluded when measured, else ∅
//     store, contents ∅ not recorded
//
//   Notification ← notification.notifications via list_notifications
//     id ✅ public_id · kind ✅ kind · title ✅ title · unread ✅ unread · at ✅ created_at
//     body      ✅ body, ∅ when the producer wrote none
//     tone      approval → approval, security → critical; run, member and
//               system carry no outcome to draw ∅
//     runId     ✅ the run public id in deep_link, else ∅ · ref ✅ deep_link
import type {
  principals,
  privacyErasureRequests,
  privacyExportRequests,
  tachoIncidents,
} from "@oxagen/database/schema";
import { TACHO_INCIDENT_KINDS } from "@oxagen/database/schema";
import type { AuditLogQueryOutput } from "@oxagen/oxagen/contracts/audit.log.query";
import type { BillingEvidenceRetentionOutput } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import type { NotificationsListOutput } from "@oxagen/oxagen/contracts/notification.list";
import type { z } from "zod";
import {
  type Actor,
  type ArchiveExport,
  type AuditEvent,
  type ErasureRequest,
  type Incident,
  IncidentKind,
  type Notification,
  type NotificationTone,
  type RetentionTier,
} from "@/data/contracts";

// ---- Source rows ---------------------------------------------------------------

/** One row of query_audit_log's output (security.security_events). */
export type SecurityEventRow = AuditLogQueryOutput["events"][number];

/**
 * The IAM decision ClickHouse audit_events recorded for the same invocation
 * (`@oxagen/telemetry` AuditEventRow), with its acting principal resolved.
 */
export type DecisionRow = {
  requestId: string;
  capability: string;
  actingPrincipalKind: "human" | "agent" | "service";
  targetKind: string | null;
  targetId: string | null;
  /** The acting principal, when `iam.principals` has it under this scope. */
  principal: ResolvedPrincipal | null;
};

/** `iam.principals` facts an actor is drawn from. */
export type ResolvedPrincipal = Pick<
  typeof principals.$inferSelect,
  "kind" | "displayName"
> & {
  /** `auth.users.public_id` of `parent_user_id`: the human the principal is. */
  userPublicId: string | null;
  /** `org.namespace.workspace.namespace.agent.slug`, for an agent principal. */
  agentKey: string | null;
};

export type SecurityEventSource = {
  event: SecurityEventRow;
  /** `auth.users.public_id` of `actor_user_id`. */
  actorPublicId: string | null;
  decision: DecisionRow | null;
};

export type IncidentRow = Pick<
  typeof tachoIncidents.$inferSelect,
  | "publicId"
  | "kind"
  | "severity"
  | "detectedAt"
  | "detectedBy"
  | "resolvedAt"
  | "resolutionNote"
> & {
  /** `tacho.hosts.agent_key` ?? `tacho.sessions.agent_key`. */
  agentKey: string | null;
  hostname: string | null;
  /** `tacho.sessions.public_id`: the run the incident was detected in. */
  sessionPublicId: string | null;
  /** `iam.principals.public_id` of `resolved_by_principal_id`. */
  resolvedByPublicId: string | null;
};

export type ErasureRow = Pick<
  typeof privacyErasureRequests.$inferSelect,
  | "publicId"
  | "scope"
  | "status"
  | "createdAt"
  | "scheduledAt"
  | "completedAt"
  | "errorMessage"
> & {
  /** `auth.users.public_id` of `user_id`: who asked, and the subject of a user-scope erasure. */
  requesterPublicId: string | null;
  /** `org.organizations.public_id`: the subject of an org-scope erasure. */
  orgPublicId: string | null;
};

export type ExportRow = Pick<
  typeof privacyExportRequests.$inferSelect,
  "publicId" | "scope" | "status" | "createdAt"
> & {
  /** `auth.users.public_id` of `user_id`. */
  requesterPublicId: string | null;
};

export type RetentionPosture = BillingEvidenceRetentionOutput;
export type NotificationRow = NotificationsListOutput["notifications"][number];

// ---- Recorded view rows ---------------------------------------------------------

type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

export type RecordedAuditEvent = Nullable<
  AuditEvent,
  "actor" | "summary" | "severity" | "ref"
>;

export type RecordedIncident = Omit<
  Nullable<Incident, "title" | "detail" | "resolution" | "scope">,
  "kind" | "severity"
> & {
  /** `tacho.incidents.kind`: twelve collector kinds, four shared with the spec's. */
  kind: string;
  /** `tacho.incidents.severity`: 1, 3 or 10 under the table's CHECK. */
  severity: number;
};

export type RecordedErasureRequest = Nullable<
  ErasureRequest,
  "subject" | "requestedById" | "status"
>;

export type RecordedArchiveExport = Nullable<
  ArchiveExport,
  | "description"
  | "from"
  | "to"
  | "contents"
  | "size"
  | "createdById"
  | "status"
  | "keys"
>;

export type RecordedRetentionTier = Nullable<
  RetentionTier,
  "store" | "contents" | "retention" | "volume"
>;

export type RecordedNotification = Nullable<Notification, "tone" | "body">;

// ---- Mappers -------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();

/**
 * Who acted. The IAM decision names the principal kind, so an agent or a
 * service is never drawn as the person whose session carried it.
 */
export function toActor(source: SecurityEventSource): Actor | null {
  const principal = source.decision?.principal ?? null;
  switch (source.decision?.actingPrincipalKind) {
    case "agent":
      return principal?.agentKey
        ? { kind: "agent", agentKey: principal.agentKey }
        : null;
    case "service":
      return principal ? { kind: "system", name: principal.displayName } : null;
    case "human": {
      const personId = principal?.userPublicId ?? source.actorPublicId;
      return personId ? { kind: "person", personId } : null;
    }
    default:
      return source.actorPublicId
        ? { kind: "person", personId: source.actorPublicId }
        : null;
  }
}

export function toAuditEvent(source: SecurityEventSource): RecordedAuditEvent {
  return {
    at: source.event.occurredAt,
    kind: source.event.eventType,
    actor: toActor(source),
    summary: null,
    severity: null,
    ref: source.decision?.targetId ?? null,
  };
}

export function toIncident(row: IncidentRow): RecordedIncident {
  return {
    id: row.publicId,
    severity: row.severity,
    kind: row.kind,
    title: null,
    at: iso(row.detectedAt),
    detectedBy: row.detectedBy,
    agentKey: row.agentKey,
    runIds: row.sessionPublicId ? [row.sessionPublicId] : [],
    scope: row.hostname ?? row.agentKey,
    detail: null,
    resolution: row.resolutionNote,
    status: row.resolvedAt ? "resolved" : "open",
    ownerId: null,
    dueOn: null,
    closedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    closedBy: row.resolvedByPublicId,
  };
}

const ERASURE_STATUS: Record<
  ErasureRow["status"],
  ErasureRequest["status"] | null
> = {
  queued: "pending",
  processing: "pending",
  completed: null,
  failed: null,
};

export function toErasureRequest(row: ErasureRow): RecordedErasureRequest {
  return {
    id: row.publicId,
    subject: row.scope === "org" ? row.orgPublicId : row.requesterPublicId,
    requestedAt: iso(row.createdAt),
    requestedById: row.requesterPublicId,
    status: ERASURE_STATUS[row.status],
    effectiveAt: row.completedAt ? iso(row.completedAt) : null,
    dueAt: iso(row.scheduledAt),
    scope: row.scope,
    holdId: null,
    note: row.errorMessage,
  };
}

const EXPORT_STATUS: Record<
  ExportRow["status"],
  ArchiveExport["status"] | null
> = {
  queued: "building",
  processing: "building",
  ready: "ready",
  failed: null,
};

export function toArchiveExport(row: ExportRow): RecordedArchiveExport {
  return {
    id: row.publicId,
    description: null,
    from: null,
    to: null,
    contents: null,
    size: null,
    createdAt: iso(row.createdAt),
    createdById: row.requesterPublicId,
    status: EXPORT_STATUS[row.status],
    signature: null,
    keys: null,
  };
}

/** The exact-payload window is the only tier a store records a retention for today. */
export function toRetentionTiers(
  posture: RetentionPosture,
): RecordedRetentionTier[] {
  return [
    {
      tier: "bodies",
      store: null,
      contents: null,
      retention:
        posture.effectiveRetentionDays === null
          ? null
          : `P${posture.effectiveRetentionDays}D`,
      volume:
        posture.storedGbMeasured && posture.storedGbBeyondIncluded !== null
          ? `${posture.storedGbBeyondIncluded} GB`
          : null,
    },
  ];
}

const NOTIFICATION_TONE: Record<
  NotificationRow["kind"],
  NotificationTone | null
> = {
  approval: "approval",
  security: "critical",
  run: null,
  member: null,
  system: null,
};

const RUN_IN_LINK = /(?:^|\/)(run_[A-Za-z0-9]+)(?=[/?#]|$)/;

export function toNotification(row: NotificationRow): RecordedNotification {
  return {
    id: row.publicId,
    kind: row.kind,
    tone: NOTIFICATION_TONE[row.kind],
    unread: row.unread,
    at: row.createdAt,
    title: row.title,
    body: row.body,
    runId: row.deepLink?.match(RUN_IN_LINK)?.[1] ?? null,
    ref: row.deepLink,
  };
}

// ---- What a view model must carry before a method serves live -----------------

/**
 * The fields (dotted, array indices dropped) a schema rejects in a sample.
 * Empty means the schema carries everything the stores record.
 */
export function rejectedPaths(schema: z.ZodType, sample: unknown): string[] {
  const parsed = schema.safeParse(sample);
  if (parsed.success) return [];
  const paths = parsed.error.issues.map((issue) =>
    issue.path.filter((p) => typeof p === "string").join("."),
  );
  return [...new Set(paths)].sort();
}

/**
 * Per method, the view-model paths a real row may leave null or carry a store
 * value the spec enum lacks. A rejection anywhere else is a mapping bug, not a
 * missing store: the adapter reports it as an error, never as not-backed.
 */
export const UNRECORDED_PATHS = {
  events: ["actor", "summary", "severity", "ref"],
  incidents: ["kind", "title", "detail", "resolution", "scope"],
  exports: [
    "description",
    "from",
    "to",
    "contents",
    "size",
    "createdById",
    "status",
    "keys",
  ],
  erasure: ["subject", "requestedById", "status"],
  retention: ["store", "contents", "retention", "volume"],
  notifications: ["tone", "body"],
} as const;

const PROBE_AT = new Date("2026-09-11T09:14:02.000Z");

/** Every collector incident kind the spec's IncidentKind does not name. */
export const COLLECTOR_ONLY_INCIDENT_KINDS = TACHO_INCIDENT_KINDS.filter(
  (kind) => !IncidentKind.safeParse(kind).success,
);

/**
 * Rows the mappers produce from the least each store can hold: every nullable
 * column null and every stored enum value. Each rejects only at its method's
 * UNRECORDED_PATHS under today's view models (mappers test), and parses whole
 * under the promoted view models listed in the PR.
 */
export const RECORDED_PROBES = {
  events: [
    toAuditEvent({
      event: {
        source: "security",
        eventType: "auth.sign_in_failed",
        occurredAt: PROBE_AT.toISOString(),
        actorUserId: null,
        workspaceId: null,
        capability: null,
        outcome: "deny",
        requestId: null,
      },
      actorPublicId: null,
      decision: null,
    }),
  ],
  incidents: TACHO_INCIDENT_KINDS.map((kind) =>
    toIncident({
      publicId: "tin_probe",
      kind,
      severity: 10,
      detectedAt: PROBE_AT,
      detectedBy: "collector",
      resolvedAt: null,
      resolutionNote: null,
      agentKey: null,
      hostname: null,
      sessionPublicId: null,
      resolvedByPublicId: null,
    }),
  ),
  exports: (["queued", "processing", "ready", "failed"] as const).map(
    (status) =>
      toArchiveExport({
        publicId: "prexp_probe",
        scope: "user",
        status,
        createdAt: PROBE_AT,
        requesterPublicId: null,
      }),
  ),
  erasure: (["queued", "processing", "completed", "failed"] as const).map(
    (status) =>
      toErasureRequest({
        publicId: "preras_probe",
        scope: "org",
        status,
        createdAt: PROBE_AT,
        scheduledAt: PROBE_AT,
        completedAt: null,
        errorMessage: null,
        requesterPublicId: null,
        orgPublicId: null,
      }),
  ),
  retention: toRetentionTiers({
    includedMonths: 12,
    effectiveRetentionDays: null,
    extendedRetentionEnabled: false,
    usdPerGbMonth: 0,
    storedGbBeyondIncluded: null,
    storedGbMeasured: false,
    creditsChargedThisPeriod: 0,
  }),
  notifications: (
    ["system", "approval", "run", "member", "security"] as const
  ).map((kind) =>
    toNotification({
      id: "0192d4a8-7c1e-7a00-8000-000000000001",
      publicId: "ntf_probe",
      kind,
      title: "probe",
      body: null,
      deepLink: null,
      unread: true,
      archived: false,
      createdAt: PROBE_AT.toISOString(),
    }),
  ),
} as const;
