import { z } from "zod";
import { defineTool } from "./_define";
import { auditLogQuery } from "../audit.log.query";
import { pluginSettingsGetAuthAlerts } from "../plugin.settings.get_auth_alerts";

/**
 * Appendix E: `query_audit_log` — "control-plane events, receipts". Absorbs
 * `query_audit_log` and `get_auth_alerts`.
 *
 * The filters carry almost whole; what changes is what they run against. A.10
 * folds `security.security_events` and the `privacy.*` request tables into one
 * `audit.audit_events` table (A.9), so the v1 `source` selector has nothing
 * left to select between. In its place the A.9 columns the single table
 * actually has become filters: severity, the target of the action, the run it
 * belongs to, and what detected it.
 *
 * §6.10 is the "receipts" half of the Does column. A receipt is the signed
 * record of one tool call, assembled by the gateway and stored as its own
 * frame, and §6.10 is explicit that receipts "are the unit the Audit page
 * searches". A receipt is not an audit-event row, so it is not inlined here:
 * the event carries the frame reference that resolves to one, which is also
 * what §14's interaction rule asks for — "every explanation is a chain of links
 * to frames, records, and commits, not a summary".
 *
 * Absorbing `get_auth_alerts` reads odd until you check the split: Appendix E
 * puts the SETTER (`set_auth_alerts`) on `set_preferences` and the READER here.
 * That is deliberate — who gets told about an auth failure is part of reading
 * the auth record, so it carries whole, as an output block rather than a
 * separate round trip for the Audit page.
 */

const auditEvent = auditLogQuery.output.shape.events.element;

/**
 * A.9 `audit.audit_events.severity`. The three levels are 1, 3 and 10 rather
 * than a smooth scale because the gap is the point: a routine control-plane
 * action, something that wants a look, and something that wants a person now.
 */
const auditSeverity = z.union([z.literal(1), z.literal(3), z.literal(10)]);

/** A.9 `detected_by`. */
const detectedBy = z.enum(["gateway", "collector", "control_plane", "human"]);

export const queryAuditLog = defineTool({
  name: "query_audit_log",
  domain: "audit",
  description:
    "Query the organization's control-plane audit events (A.9 audit.audit_events) with filters — actor, tool, outcome, event kind, severity, target, run, detector, time range — returning a time-ordered feed, each event linked to the receipt frame that proves it (§6.10). Also returns who is configured to receive auth-failure alerts. Read-only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["query_audit_log", "get_auth_alerts"],
  drops: [
    {
      field: "source",
      from: "query_audit_log",
      why: "the input selector chose between audit spines. A.10 folds security.security_events and the privacy.* request tables into the single audit.audit_events table (A.9), so there is one spine and nothing to select",
    },
    {
      field: "events[].source",
      from: "query_audit_log",
      why: "the same collapse seen from the output side: every row came from `security`, and a constant field on every row is noise. A.9's `detectedBy` is the distinction that replaced it — what observed the event, not which table held it",
    },
  ],

  /**
   * Strictest of the two on every axis. `query_audit_log` is sensitivity high
   * and `get_auth_alerts` low; high wins — this is the record of who did what
   * to the control plane, and §13.3 keeps it for seven years.
   *
   * At workspace scope the strict source is `get_auth_alerts`, which grants
   * nothing, and that is also the right answer independently: §14 puts Audit
   * among the three organization-scope pages. The v1 workspace-Owner grant does
   * not carry. Narrowing to one workspace is still possible through the
   * `workspaceId` filter, which is a filter on an org-scope read rather than a
   * workspace-scope grant.
   */
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  /**
   * Carried from get_auth_alerts and extended to the whole tool. §12.1 gives
   * every organization the free tier with "every governance feature on", and an
   * audit trail that goes dark when the balance does is not an audit trail.
   */
  noBillingGate: true,
  // Carried from both: two SELECT handlers, neither with a write path.
  mutates: false,

  input: z.object({
    // Carried: the filter set, each with the description that says what it
    // matches. `eventType` keeps its exact-match semantics and now matches A.9's
    // `kind`, which is the same column under the spec's name.
    eventType: auditLogQuery.input.shape.eventType,
    actorUserId: auditLogQuery.input.shape.actorUserId,
    capability: auditLogQuery.input.shape.capability,
    outcome: auditLogQuery.input.shape.outcome,
    workspaceId: auditLogQuery.input.shape.workspaceId,
    from: auditLogQuery.input.shape.from,
    to: auditLogQuery.input.shape.to,
    // Carried: the 1-200 clamp and the 50 default exist so an agent cannot ask
    // for the whole seven years in one response.
    limit: auditLogQuery.input.shape.limit,
    offset: auditLogQuery.input.shape.offset,

    // New, from A.9's columns — the filters the single table makes possible.
    /** Floor rather than exact match: an auditor asking for 3 wants 10 as well. */
    minSeverity: auditSeverity.optional(),
    targetKind: z.string().optional(),
    targetId: z.string().optional(),
    /** Everything the control plane recorded about one run (A.9 `run_id`). */
    runId: z.string().optional(),
    detectedBy: detectedBy.optional(),
  }),

  output: z.object({
    events: z.array(
      auditEvent
        // See `drops`: the constant column goes, and A.9's columns arrive.
        .omit({ source: true })
        .extend({
          severity: auditSeverity,
          /** What the action was performed on (A.9 `target_kind` / `target_id`). */
          targetKind: z.string().nullable(),
          targetId: z.string().nullable(),
          /** The run this belongs to, when it belongs to one (A.9 `run_id`). */
          runId: z.string().nullable(),
          detectedBy,
          /**
           * §6.10: the receipt is the signed record of the call and "the unit
           * the Audit page searches". It lives in the ledger as its own frame,
           * so the event carries the reference rather than a copy — a copy
           * would be an unsigned summary of a signed thing.
           */
          receiptFrameId: z.string().nullable(),
          /** A.9 `evidence`: what the detector attached. Shape varies by kind. */
          evidence: z.record(z.unknown()).nullable(),
        }),
    ),
    // Carried: page size, offset and the has-more flag, so a caller paging
    // through seven years knows when to stop.
    total: auditLogQuery.output.shape.total,
    hasMore: auditLogQuery.output.shape.hasMore,
    limit: auditLogQuery.output.shape.limit,
    offset: auditLogQuery.output.shape.offset,

    /**
     * Carried whole from get_auth_alerts — nothing dropped. `isDefault` matters
     * most of the three: it is the difference between an org that chose Owner
     * and Admin and one that has never looked, and an auditor reading an alert
     * list needs to know which it is.
     */
    authAlerts: z.object({
      sendEmail: pluginSettingsGetAuthAlerts.output.shape.sendEmail,
      roles: pluginSettingsGetAuthAlerts.output.shape.roles,
      isDefault: pluginSettingsGetAuthAlerts.output.shape.isDefault,
    }),
  }),
});

export type QueryAuditLogInput = z.output<typeof queryAuditLog.input>;
export type QueryAuditLogOutput = z.output<typeof queryAuditLog.output>;
