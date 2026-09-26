// get_agent — one agent with its credentials, roles, enrollment, the runtime
// and toolbelt it is bound to, and its versions, in one read (ADR-192; MC
// spec §6.2, App. E; #2956). The read behind the Agents detail page.
//
// `noBillingGate: true`, `mutates: false`: a console read (INV-28).
//
// An agent is one operator on one runtime with one harness (ADR-192). The
// principal, the operator and the harness never change; `versions` records
// each runtime and toolbelt the agent has had, newest first. No secret leaves
// this read: a credential shows its prefix and dates, a host its key
// fingerprint.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  hostEnrollmentIdSchema,
  tachoBundleModeSchema,
  tachoHostStatusSchema,
  tachoPlatformSchema,
} from "../tacho/schemas";
import { agentHarnessSchema, agentIdentityStatusSchema } from "./agent.list";
import { costCenterLabelSchema } from "./cost_center.shared";
import { runtimeRefSchema } from "./runtime.shared";
import { moneySchema } from "./spend.shared";
import { toolbeltRefSchema } from "./toolbelt.shared";

const instant = z.string().datetime({ offset: true });

export const agentCredentialSchema = z
  .object({
    /** `aky_…`. */
    id: z.string().regex(/^aky_[0-9a-z]+$/),
    name: z.string(),
    /** The key's fixed leading window; never the secret or its hash. */
    prefix: z.string().min(1),
    createdAt: instant,
    expiresAt: instant.nullable(),
    lastUsedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .strict();

export const agentRoleAssignmentSchema = z
  .object({
    /** `rol_…`. */
    id: z.string().regex(/^rol_[0-9a-z]+$/),
    name: z.string().min(1),
    scopeKind: z.enum(["org", "workspace"]),
    isSystemDefault: z.boolean(),
    assignedAt: instant,
    /** Null for a standing assignment. */
    expiresAt: instant.nullable(),
  })
  .strict();

export const agentHostSchema = z
  .object({
    hostEnrollmentId: hostEnrollmentIdSchema,
    hostname: z.string(),
    platform: tachoPlatformSchema,
    status: tachoHostStatusSchema,
    mode: tachoBundleModeSchema,
    harnesses: z.array(z.string()),
    /** sha256 of the host's Ed25519 device key. */
    deviceKeyFingerprint: z.string(),
    /** The collector (wrapper) version the host reported at enrollment. */
    collectorVersion: z.string().nullable(),
    /** Whether the hooks the collector wrote are in place; null until the daemon reports. */
    hooksOk: z.boolean().nullable(),
    /** The policy bundle version the host last fetched; null before the first fetch. */
    bundleVersionServed: z.number().int().nullable(),
    lastSeenAt: instant.nullable(),
    expiresAt: instant,
    revokedAt: instant.nullable(),
  })
  .strict();

/** Why a version exists (`agent_versions.change_kind`). */
export const agentVersionChangeKindSchema = z.enum([
  "registered",
  "runtime_changed",
  "toolbelt_changed",
  "legacy",
]);

/** One agent version: what the agent was bound to from that version on. */
export const agentVersionSchema = z
  .object({
    version: z.number().int().positive(),
    changeKind: agentVersionChangeKindSchema,
    /** Null on a legacy version and on an agent that runs on no named runtime. */
    runtime: runtimeRefSchema.nullable(),
    /** Null on a legacy version. */
    toolbelt: toolbeltRefSchema.nullable(),
    /** `usr_…` of the person who wrote the version. */
    createdBy: z.string().nullable(),
    createdAt: instant,
  })
  .strict();
export type AgentVersion = z.output<typeof agentVersionSchema>;

/**
 * The limits the agent's active version sets in its config (ADR-192): the
 * per-run and per-day spend ceilings the host bundle enforces, and whether the
 * agent must run under the contained launcher (ADR-152). A ceiling the config
 * does not name is null. `invalid` is true when the config cannot be read,
 * which is the state in which the host suspends governed actions; every other
 * field then names nothing.
 */
export const agentLimitsSchema = z
  .object({
    perRun: moneySchema.nullable(),
    perDay: moneySchema.nullable(),
    containmentRequired: z.boolean(),
    invalid: z.boolean(),
  })
  .strict();
export type AgentLimits = z.output<typeof agentLimitsSchema>;

export const agentGet = registerCapability({
  name: "get_agent",
  domain: "agent",
  description:
    "Read one agent: principal, harness, operator and status; the runtime it runs on and the toolbelt it carries; its versions; its long-lived credentials; the roles on its principal; and the hosts enrolled under it.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      /** Agent public id (`agt_…`) or slug. */
      agentId: z.string().min(1).max(128),
    })
    .strict(),
  output: z
    .object({
      identity: z
        .object({
          id: z.string().regex(/^agt_[0-9a-z]+$/),
          slug: z.string().min(1),
          name: z.string().min(1),
          description: z.string().nullable(),
          agentKey: z.string().nullable(),
          harness: agentHarnessSchema,
          /** True for the built-in assistant (`qa-chat`), which no identity write accepts. */
          managed: z.boolean(),
          principalId: z.string().nullable(),
          operatorId: z.string().nullable(),
          status: agentIdentityStatusSchema,
          registeredAt: instant,
          /** The start of the earliest run either store recorded for the agent; null before the first. */
          firstFrameAt: instant.nullable(),
          /** The cost-center label the agent's spend is charged to (ADR-142), or null when it inherits the workspace's. */
          costCenter: costCenterLabelSchema.nullable(),
        })
        .strict(),
      /** The runtime the agent runs on now; null when it runs on no named runtime. */
      runtime: runtimeRefSchema.nullable(),
      /** The toolbelt the agent carries now. */
      toolbelt: toolbeltRefSchema.nullable(),
      /** Every version, newest first, at most 100. */
      versions: z.array(agentVersionSchema).max(100),
      /** The limits the active version's config sets. */
      limits: agentLimitsSchema,
      credentials: z.array(agentCredentialSchema),
      roles: z.array(agentRoleAssignmentSchema),
      hosts: z.array(agentHostSchema),
    })
    .strict(),
});

export type AgentGetInput = z.output<typeof agentGet.input>;
export type AgentGetOutput = z.output<typeof agentGet.output>;
