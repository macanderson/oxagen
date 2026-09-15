// list_incidents — the workspace's tamper and integrity incidents (MC spec
// App. E; #2956), newest first, cursor-paged, optionally narrowed to one
// agent. The read behind the Agents detail page's incidents tab.
//
// `tacho.incidents` is the one incident store: the collector, the control
// plane and a person record hooks removed, chain breaks, token replays,
// spoofed events, telemetry gaps and the rest (`TACHO_INCIDENT_KINDS`). No
// mandate-exception store exists, so no such row can appear here.
//
// `noBillingGate: true`, `mutates: false`: a console read (INV-28).
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

const instant = z.string().datetime({ offset: true });

/** The `tacho.incidents.kind` CHECK (packages/database/src/schema/tacho.ts). */
export const incidentKindSchema = z.enum([
  "unobserved_session",
  "hooks_removed",
  "config_change",
  "telemetry_gap",
  "chain_break",
  "checkpoint_lapse",
  "token_replay",
  "policy_violation",
  "spoofed_event",
  "daemon_down",
  "otel_missing",
  "unknown_model_cost",
]);
export type IncidentKind = z.output<typeof incidentKindSchema>;

/** The kinds that mean the record itself was interfered with. */
export const TAMPER_INCIDENT_KINDS: readonly IncidentKind[] = [
  "hooks_removed",
  "config_change",
  "chain_break",
  "checkpoint_lapse",
  "token_replay",
  "spoofed_event",
];

export const incidentItemSchema = z
  .object({
    /** `tin_…`. */
    id: z.string().regex(/^tin_[0-9a-z]+$/),
    kind: incidentKindSchema,
    /** 1 (notice), 3 (warning) or 10 (tamper). */
    severity: z.union([z.literal(1), z.literal(3), z.literal(10)]),
    detectedAt: instant,
    detectedBy: z.enum(["collector", "control_plane", "human"]),
    /** The host the incident was raised on; null for a control-plane finding with no host. */
    hostEnrollmentId: hostEnrollmentIdSchema.nullable(),
    /** The session's public id (`tse_…`); null when the incident is not on a session. */
    sessionId: z.string().nullable(),
    /** The agent key of the host; null when no host is named. */
    agentKey: z.string().nullable(),
    /** What the detector recorded. */
    evidence: z.record(z.string(), z.unknown()),
    resolvedAt: instant.nullable(),
    resolutionNote: z.string().nullable(),
  })
  .strict();

export const tachoIncidentList = registerCapability({
  name: "list_incidents",
  domain: "tacho",
  description:
    "List the workspace's tamper and integrity incidents, newest first, cursor-paged, optionally narrowed to one agent or to open incidents.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Only incidents on hosts enrolled under this agent (`agt_…` or slug). */
      agentId: z.string().min(1).max(128).optional(),
      /** Only unresolved incidents. */
      open: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(incidentItemSchema).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type TachoIncidentListInput = z.output<typeof tachoIncidentList.input>;
export type TachoIncidentListOutput = z.output<typeof tachoIncidentList.output>;
export type IncidentItem = z.output<typeof incidentItemSchema>;
