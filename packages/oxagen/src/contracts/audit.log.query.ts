import { z } from "zod";
import { registerCapability } from "../registry";

// Authz outcomes recorded on security_events. Mirrors @oxagen/compliance's
// SECURITY_OUTCOMES (kept inline to avoid coupling the core contracts package
// to compliance); the set is stable and small.
const SECURITY_OUTCOMES = ["allow", "deny", "error", "success"] as const;

/**
 * audit.log.query — make the SOC 2 audit spine agent-queryable.
 *
 * Audit events are written everywhere (security_events for capability/auth/IAM
 * activity, playbook_events for the hash-chained automation spine) but until now
 * only export paths existed. This capability lets an admin (or the agent on
 * their behalf) ask "who changed the billing plan last week?" with structured
 * filters, returning a unified, time-ordered event feed. Read-only, org-scoped.
 */

const auditSource = z.enum(["all", "security", "playbook"]);

const auditEvent = z.object({
  source: z
    .enum(["security", "playbook"])
    .describe("Which audit spine the event came from"),
  eventType: z
    .string()
    .describe("Event classification (e.g. capability.invoked, run_completed)"),
  occurredAt: z
    .string()
    .describe("ISO-8601 timestamp of when the event occurred"),
  actorUserId: z
    .string()
    .nullable()
    .describe("User who triggered the event, when known"),
  workspaceId: z.string().nullable(),
  capability: z
    .string()
    .nullable()
    .describe("Capability name for capability.* security events"),
  outcome: z
    .string()
    .nullable()
    .describe("Authz outcome for security events (allow/deny/error/success)"),
  requestId: z.string().nullable(),
  playbookRunId: z
    .string()
    .nullable()
    .describe("Playbook run id for playbook_events"),
  sequence: z
    .number()
    .int()
    .nullable()
    .describe("Per-run monotonic counter for playbook_events"),
  eventData: z
    .record(z.unknown())
    .nullable()
    .describe("Structured payload for playbook_events"),
});

export const auditLogQuery = registerCapability({
  name: "query_audit_log",
  domain: "audit",
  description:
    "Query the org's security and automation audit events (security_events + playbook_events) with filters — actor, capability, outcome, event type, time range — returning a unified, time-ordered feed. Read-only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  // "app": the org Governance hub invokes this for the denied-invocation feed
  // (binding in apps/app/capability-ui-map.json — UI Capability Parity law).
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "high",
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
    eventType: z
      .string()
      .optional()
      .describe("Exact event-type match (e.g. 'billing.plan_changed')"),
    actorUserId: z
      .string()
      .optional()
      .describe("Filter security events by the acting user id"),
    capability: z
      .string()
      .optional()
      .describe("Filter security events by capability name"),
    outcome: z
      .enum(SECURITY_OUTCOMES)
      .optional()
      .describe("Filter security events by authz outcome"),
    playbookRunId: z
      .string()
      .optional()
      .describe("Filter playbook events to a single run"),
    workspaceId: z
      .string()
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
