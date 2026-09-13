// Agents: identity, run credential, toolbelt, definition and scores
// (spec §6.2–§6.6, App. A.4 `iam.principals`).
import { z } from "zod";
import {
  AgentKey,
  Avatar,
  CommitSha,
  Count,
  Digest,
  EnforcementTier,
  Harness,
  Instant,
  ModelTier,
  Money,
  PublicId,
  Ratio,
  ReplayGrade,
  Slug,
  ToolVersionRef,
} from "./common";
import { RoleAssignment } from "./iam";

/** `iam.principals.status`. */
export const AgentStatus = z.enum([
  "unenrolled",
  "active",
  "suspended",
  "retired",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentRow = z.object({
  key: AgentKey,
  name: z.string(),
  description: z.string(),
  harness: Harness,
  harnessVersion: z.string(),
  workspaceSlug: Slug,
  operatorId: PublicId,
  status: AgentStatus,
  /** The tier the gateway enforces. */
  tier: EnforcementTier,
  /** The tier the harness reaches without the gateway. */
  nativeTier: EnforcementTier,
  beltSize: Count,
  /** Above the full-belt limit the model gets a searchable belt instead. */
  beltMode: z.enum(["full", "searchable"]),
  runs30d: Count,
  spend30d: Money,
  proven30d: Money,
  productiveRatio: Ratio,
  openIncidents: Count,
  mandateIds: z.array(PublicId),
  modelTier: ModelTier,
  avatar: Avatar,
});
export type AgentRow = z.infer<typeof AgentRow>;

export const AgentDetail = AgentRow.extend({
  identity: z.object({
    principalId: PublicId,
    host: z.string(),
    enrolled: z.boolean(),
    collectorVersion: z.string(),
    deviceKey: z.string(),
    firstFrameAt: Instant,
    /** The strongest replay grade this agent's runs record. */
    replayGrade: ReplayGrade,
  }),
  credential: z.object({
    prefix: z.string(),
    issuedAt: Instant,
    lastUsedAt: Instant,
    activeRunTokens: Count,
  }),
  definition: z.object({
    path: z.string(),
    digest: Digest,
    commitSha: CommitSha,
  }),
  budget: z.object({
    perRun: Money,
    /** Spend of the latest run against the per-run cap. */
    lastRunSpend: Money,
    perDay: Money,
    usedToday: Money,
  }),
  roles: z.array(RoleAssignment),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

/** How the gateway decides one tool on this belt; `mandate` means a mandate bounds it. */
export const BeltDecision = z.enum([
  "allow",
  "deny",
  "require_approval",
  "mandate",
]);
export type BeltDecision = z.infer<typeof BeltDecision>;

export const ToolbeltEntry = z.object({
  tool: ToolVersionRef,
  description: z.string(),
  decision: BeltDecision,
  /** The grant, definition line or policy rule that decides it. */
  rule: z.string(),
  scope: z.string().nullable(),
  pinned: z.boolean(),
  /** A meta-tool of the searchable belt (search_tools, load_tools). */
  meta: z.boolean(),
  note: z.string().nullable(),
});
export type ToolbeltEntry = z.infer<typeof ToolbeltEntry>;

export const Toolbelt = z.object({
  agentKey: AgentKey,
  mode: z.enum(["full", "searchable"]),
  entries: z.array(ToolbeltEntry),
  /** Registry versions no belt in this workspace reaches, and why. */
  outside: z.array(z.object({ tool: z.string(), reason: z.string() })),
  registryVersions: Count,
  fullBeltLimit: Count,
});
export type Toolbelt = z.infer<typeof Toolbelt>;

export const AgentBranch = z.object({
  name: z.string(),
  pullRequestRef: z.string().nullable(),
  commitsAhead: Count,
  authorId: PublicId,
});
export type AgentBranch = z.infer<typeof AgentBranch>;

/** The definition in git: `.oxagen/agents/<slug>.toml` on the main repo (spec §6.2). */
export const AgentDefinition = z.object({
  agentKey: AgentKey,
  path: z.string().regex(/^\.oxagen\/agents\/[a-z0-9-]+\.toml$/),
  digest: Digest,
  commitSha: CommitSha,
  source: z.string(),
  branches: z.array(AgentBranch),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** Trust and spend scores, 0–1000 (G11: mockup-only until the spec decides). */
export const AgentScores = z.object({
  agentKey: AgentKey,
  trust: z.number().int().min(0).max(1000),
  spend: z.number().int().min(0).max(1000),
});
export type AgentScores = z.infer<typeof AgentScores>;
