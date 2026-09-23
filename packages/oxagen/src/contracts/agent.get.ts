// get_agent — one agent identity with its credentials, roles, enrollment and
// the definition of record, in one read (MC spec §6.2, App. E; #2956). The
// read behind the Agents detail page's identity, definition and enrollment
// tabs.
//
// `noBillingGate: true`, `mutates: false`: a console read (INV-28).
//
// The identity lives in Postgres and the definition in git (ADR-057
// decision 1). `definition` is the cache the last `commit_agent_definition`
// left on the version row, or null when the agent has no committed
// definition. No secret leaves this read: a credential shows its prefix and
// dates, a host its key fingerprint.
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

export const agentDefinitionRecordSchema = z
  .object({
    /** The `agent_versions.version` that cached the commit. */
    version: z.number().int().positive(),
    path: z.string().min(1),
    /** sha256 hex of the file at `commitSha`. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    commitSha: z.string().min(1),
    branch: z.string().min(1),
    pullRequestUrl: z.string().url(),
    /** The file text as committed. */
    source: z.string(),
    committedAt: instant,
  })
  .strict();

export const agentGet = registerCapability({
  name: "get_agent",
  domain: "agent",
  description:
    "Read one agent identity: principal, harness, operator and status; its long-lived credentials; the roles on its principal; the hosts enrolled under it; and the definition of record the last commit cached.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
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
      credentials: z.array(agentCredentialSchema),
      roles: z.array(agentRoleAssignmentSchema),
      hosts: z.array(agentHostSchema),
      definition: agentDefinitionRecordSchema.nullable(),
    })
    .strict(),
});

export type AgentGetInput = z.output<typeof agentGet.input>;
export type AgentGetOutput = z.output<typeof agentGet.output>;
