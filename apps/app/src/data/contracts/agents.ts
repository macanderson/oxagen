// The Agents (Agent IAM) view models (ARCHITECTURE.md §1.2 Agents row, #2956):
// the identities list from `list_agents`, one agent from `get_agent`, its
// computed toolbelt from `get_agent_toolbelt` and its incidents from
// `list_incidents`. A field is nullable exactly where the contract may not have
// recorded it (§3.4). The contract fields no store records today (model tier,
// belt size, proven runs) have no view field.
import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";
import { EnforcementTier } from "./runs";

const Instant = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();

const AgentHarness = z.enum([
  "stella",
  "claude-code",
  "codex",
  "cursor",
  "claude-agent-sdk",
  "custom",
]);

/** Derived on the read: retired (archived), suspended (principal), enrolled (a live credential or host), unenrolled. */
export const AgentStatus = z.enum([
  "unenrolled",
  "enrolled",
  "suspended",
  "retired",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

const AgentRow = z.object({
  id: PublicId,
  slug: z.string().min(1),
  name: z.string().min(1),
  /** What the agent is for; null when the definition wrote none. */
  description: z.string().nullable(),
  /** `org_ns.ws_ns.slug` (ADR-024). */
  agentKey: z.string().min(1).nullable(),
  harness: AgentHarness,
  operatorId: PublicId.nullable(),
  operatorName: z.string().nullable(),
  principalId: PublicId.nullable(),
  credentials: Count,
  hosts: Count,
  /** The live host seen most recently; null when none is live. */
  host: z.string().nullable(),
  status: AgentStatus,
  /** The tier the latest wrapped session recorded; null when none was. */
  enforcementTier: EnforcementTier.nullable(),
  runs30d: Count,
  /** Priced wrapped sessions in the last 30 days, with the basis the harness reported. */
  spend30d: Cost.nullable(),
  /**
   * The tokens the agent's wrapped sessions reported over the last 30 days,
   * with cache read over input; null when no session reported a token.
   * Ledger runs' tokens are not in it.
   */
  tokens30d: z
    .object({
      total: Count,
      cacheReadRate: z.number().min(0).max(1).nullable(),
      sessions: Count,
    })
    .nullable(),
  /** Active mandates the principal holds; null on a row with no principal. */
  mandates: Count.nullable(),
  incidents: Count,
  /** Open incidents of a tamper kind, which is what the Health cell reads. */
  tamperIncidents: Count,
  /** Every tamper incident on the agent's hosts the store keeps: the Incidents column. */
  tamperIncidentsRecorded: Count,
});

export const AgentPage = z.object({
  agents: z.array(AgentRow),
  nextCursor: z.string().nullable(),
  /** Over the whole workspace, not the page. */
  totals: z.object({
    /** Live agents. A retired agent is in no total but `retired`. */
    identities: Count,
    /** Retired (deregistered) agents, which the page hides until asked. */
    retired: Count,
    enrolled: Count,
    /** Agents waiting to enroll: not suspended, no credential and no host. */
    unenrolled: Count,
    /** Agents in the workspace holding at least one active mandate. */
    holdingMandate: Count.nullable(),
    /** The agent keys `holdingMandate` counts, at most 100: the names the tile prints. */
    mandateHolders: z.array(z.string().min(1)),
    tamperIncidents: Count,
    /** The Tamper incidents tile: sums over the agents' records, and the newest incident. */
    tamper: z.object({
      recorded: Count,
      open: Count,
      newest: z
        .object({
          agentKey: z.string().min(1),
          kind: z.string().min(1),
          detectedAt: Instant,
        })
        .nullable(),
    }),
  }),
});
export type AgentPage = z.infer<typeof AgentPage>;

export const AgentDetail = z.object({
  identity: z.object({
    id: PublicId,
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    agentKey: z.string().min(1).nullable(),
    harness: AgentHarness,
    principalId: PublicId.nullable(),
    operatorId: PublicId.nullable(),
    status: AgentStatus,
    registeredAt: Instant,
    firstFrameAt: Instant.nullable(),
    /** The cost-center label the agent is charged to, or null when it inherits the workspace's (ADR-142). */
    costCenter: z.string().min(1).nullable(),
  }),
  /** Long-lived credentials: the prefix and dates, never the secret. */
  credentials: z.array(
    z.object({
      id: PublicId,
      name: z.string(),
      prefix: z.string().min(1),
      createdAt: Instant,
      expiresAt: Instant.nullable(),
      lastUsedAt: Instant.nullable(),
      revokedAt: Instant.nullable(),
    }),
  ),
  roles: z.array(
    z.object({
      id: PublicId,
      name: z.string().min(1),
      scopeKind: z.enum(["org", "workspace"]),
      assignedAt: Instant,
      expiresAt: Instant.nullable(),
    }),
  ),
  hosts: z.array(
    z.object({
      hostEnrollmentId: PublicId,
      hostname: z.string(),
      platform: z.string().min(1),
      status: z.string().min(1),
      mode: z.string().min(1),
      deviceKeyFingerprint: z.string(),
      collectorVersion: z.string().nullable(),
      hooksOk: z.boolean().nullable(),
      bundleVersionServed: z.number().int().nullable(),
      lastSeenAt: Instant.nullable(),
      expiresAt: Instant,
      revokedAt: Instant.nullable(),
    }),
  ),
  /** The commit the last `commit_agent_definition` cached; null before the first. */
  definition: z
    .object({
      path: z.string().min(1),
      digest: z.string().min(1),
      commitSha: z.string().min(1),
      branch: z.string().min(1),
      pullRequestUrl: z.url(),
      source: z.string(),
      committedAt: Instant,
    })
    .nullable(),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

const ToolKind = z.enum(["capability", "mcp"]);

export const Toolbelt = z.object({
  computedAt: Instant,
  /** How the belt was computed. */
  computation: z.object({
    humanCeiling: z.enum(["caller", "sentinel"]),
    roleGrants: Count,
    denyGeneration: z.object({ org: Count, workspace: Count }),
    killSwitches: Count,
  }),
  presentation: z.object({
    mode: z.enum(["full", "searchable"]),
    limit: z.number().int().positive(),
    sentToModel: z.enum(["definitions", "meta_tools"]),
  }),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      kind: ToolKind,
      server: z.string().nullable(),
      category: z.string().nullable(),
      riskLevel: z.enum(["low", "medium", "high"]),
      decision: z.enum(["allow", "require_approval"]),
      rule: z.string().min(1),
      readOnly: z.boolean(),
      /**
       * The JSON Schema the model is handed for this tool. Null when nothing
       * records one, and null when the schema is over the size the belt
       * carries inline; `schemaTruncated` tells the two apart.
       */
      inputSchema: z.record(z.string(), z.unknown()).nullable(),
      /** Where the schema came from; null exactly when none resolved. */
      schemaOrigin: z.enum(["declared", "imported"]).nullable(),
      /** SHA-256 over the canonical schema JSON; present whenever one resolved. */
      schemaDigest: z.string().nullable(),
      schemaTruncated: z.boolean(),
    }),
  ),
  cannotSee: z.array(
    z.object({
      name: z.string().min(1),
      kind: ToolKind,
      server: z.string().nullable(),
      rule: z.string().min(1),
    }),
  ),
});
export type Toolbelt = z.infer<typeof Toolbelt>;

export const IncidentPage = z.object({
  incidents: z.array(
    z.object({
      id: PublicId,
      kind: z.string().min(1),
      /** `tacho.incidents.severity` 1, 3 and 10. */
      severity: z.enum(["notice", "warning", "tamper"]),
      detectedAt: Instant,
      detectedBy: z.enum(["collector", "control_plane", "human"]),
      sessionId: PublicId.nullable(),
      resolvedAt: Instant.nullable(),
      resolutionNote: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type IncidentPage = z.infer<typeof IncidentPage>;
