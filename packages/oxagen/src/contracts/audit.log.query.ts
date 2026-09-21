import { z } from "zod";
import { registerCapability } from "../registry";

// Authz outcomes recorded on security_events. Mirrors @oxagen/compliance's
// SECURITY_OUTCOMES (kept inline to avoid coupling the core contracts package
// to compliance); the set is stable and small.
const SECURITY_OUTCOMES = ["allow", "deny", "error", "success"] as const;

/**
 * audit.log.query — make the SOC 2 audit spine agent-queryable.
 *
 * Audit events are written to security_events for capability/auth/IAM
 * activity. This capability lets an admin (or the agent on their behalf) ask
 * "who changed the billing plan last week?" with structured filters, returning
 * a time-ordered event feed. Read-only, org-scoped.
 *
 * Reading the record is never a governed action: an audit trail that goes
 * dark when the GAU balance does is not an audit trail (ADR-052 exclusion 2,
 * apps/app/ARCHITECTURE.md INV-28), so the contract declares `noBillingGate`.
 * Roles are checked in the handler (INV-29): org Owner or Admin for the whole
 * organization or another workspace, and the workspace Owner for the call's
 * own workspace.
 */

const auditSource = z.enum(["all", "security"]);

/**
 * Re-exported from `../types`, which holds the one definition (ADR-068
 * decision 1). It stays reachable from this path because every surface that
 * mounts `query_audit_log` or `export_audit_events` org-wide imports it from
 * beside the contracts, and a second literal is a pair of constants that must
 * never diverge. A call carrying it is treated as having no workspace scope:
 * `query_audit_log` answers for the whole organization and
 * `export_audit_events` signs the whole organization's record.
 */
export { ORG_ONLY_WORKSPACE_ID } from "../types";

/**
 * The filters `query_audit_log` and `export_audit_events` share, so the rows a
 * reader pages through are the rows an export signs.
 */
export const auditEventFilters = {
  eventType: z
    .string()
    .optional()
    .describe("Exact event-type match (e.g. 'billing.plan_changed')"),
  // A uuid, because the column is one: an arbitrary string reaches PostgreSQL
  // and fails the uuid cast there, which answers a store error where the
  // caller's input is what is wrong.
  actorUserId: z
    .string()
    .uuid()
    .optional()
    .describe("Filter by the acting user's id"),
  actorPublicId: z
    .string()
    .optional()
    .describe("Filter by the acting user's public id (usr_…)"),
  capability: z.string().optional().describe("Filter by capability name"),
  outcome: z
    .enum(SECURITY_OUTCOMES)
    .optional()
    .describe("Filter by authz outcome"),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe("Restrict to one workspace (default: all in org)"),
  from: z
    .string()
    .datetime()
    .optional()
    .describe("Inclusive ISO-8601 lower bound on occurredAt"),
  to: z
    .string()
    .datetime()
    .optional()
    .describe("Exclusive ISO-8601 upper bound on occurredAt"),
};

const auditEvent = z.object({
  id: z.string().describe("The security event's id"),
  detail: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      "Stored event evidence, including approval-rule invalidation facts",
    ),
  source: z
    .enum(["security"])
    .describe("Which audit spine the event came from"),
  eventType: z
    .string()
    .describe("Event classification (e.g. capability.invoke_denied)"),
  occurredAt: z
    .string()
    .describe("ISO-8601 timestamp of when the event occurred"),
  actorUserId: z
    .string()
    .nullable()
    .describe("User who triggered the event, when known"),
  actorPublicId: z
    .string()
    .nullable()
    .describe("The acting user's public id (usr_…), when the user exists"),
  workspaceId: z.string().nullable(),
  workspaceSlug: z
    .string()
    .nullable()
    .describe("The workspace's slug, when the event names a workspace"),
  capability: z
    .string()
    .nullable()
    .describe("Capability name for capability.* security events"),
  outcome: z
    .string()
    .nullable()
    .describe("Authz outcome for security events (allow/deny/error/success)"),
  ip: z.string().nullable().describe("Client IP address, when recorded"),
  userAgent: z.string().nullable().describe("Client user agent, when recorded"),
  requestId: z.string().nullable(),
});

export const auditLogQuery = registerCapability({
  name: "query_audit_log",
  domain: "audit",
  description:
    "Query the org's security audit events (security_events) with filters — actor, capability, outcome, event type, time range — returning a time-ordered feed. Read-only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  // "app": the org Governance hub invokes this for the denied-invocation feed
  // (binding in apps/app/capability-ui-map.json — UI Capability Parity law).
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "high",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    // Audit data is admin-level: org Owner/Admin and workspace Owner only.
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    source: auditSource
      .default("all")
      .describe("Which audit spine(s) to query"),
    ...auditEventFilters,
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max events to return (default 50)"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  }),
  output: z.object({
    events: z.array(auditEvent).describe("Matching events, newest first"),
    total: z.number().int().describe("Number of events in this page"),
    hasMore: z.boolean().describe("Whether more events exist beyond this page"),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});

export type AuditLogQueryInput = z.output<typeof auditLogQuery.input>;
export type AuditLogQueryOutput = z.output<typeof auditLogQuery.output>;
export type AuditEvent = z.output<typeof auditEvent>;
