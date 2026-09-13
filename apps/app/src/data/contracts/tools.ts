// The Tools page: registry, connections, observed schemas, kill switches,
// auto-approval rules and the assurance suite (spec §6.4–§6.13, App. A.5).
import { z } from "zod";
import {
  ConsequenceTag,
  Count,
  Day,
  Digest,
  EgressClass,
  Instant,
  Money,
  PublicId,
  Risk,
  SchemaOrigin,
  SideEffect,
  Slug,
  ToolPattern,
} from "./common";

export const ServerId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type ServerId = z.infer<typeof ServerId>;

export const ToolServer = z.object({
  id: ServerId,
  name: z.string(),
  /** `tools.tool_servers.kind`. */
  kind: z.enum(["mcp", "http", "harness", "oxagen"]),
  /** `tools.tool_servers.transport`; harness-native tools arrive `builtin` through hooks. */
  transport: z.enum(["streamable_http", "stdio", "openapi", "builtin"]),
  endpoint: z.string(),
  toolCount: Count,
  versionCount: Count,
  /** `tools.tool_servers.status`: a server behind a kill switch is `killed`. */
  status: z.enum(["active", "disabled", "killed"]),
  health: z.enum(["ok", "degraded"]),
  /** Null for servers that ship with a release or a harness version. */
  lastImportAt: Instant.nullable(),
  connectionId: PublicId.nullable(),
  /** Observed output schemas waiting for a person to approve them. */
  pendingSchemaCount: Count,
});
export type ToolServer = z.infer<typeof ToolServer>;

export const DownscopeMethod = z.enum([
  "token_exchange",
  "session_policy",
  "restricted_key",
  "none",
]);
export type DownscopeMethod = z.infer<typeof DownscopeMethod>;

/** `tools.connections.kind`. */
export const ConnectionKind = z.enum([
  "oauth",
  "api_key",
  "cloud_role",
  "github_app",
  "model_provider",
]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/** One row of the registry: one tool version with its safety classification (§6.9). */
export const ToolVersion = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  version: z.string().regex(/^[0-9][0-9.]*$/),
  serverId: ServerId,
  risk: Risk,
  sideEffect: SideEffect,
  egress: EgressClass,
  consequenceTags: z.array(ConsequenceTag),
  schemaOrigin: SchemaOrigin,
  /** Null while an observed schema awaits approval. */
  schemaDigest: Digest.nullable(),
  /** A declared per-call price; null when the tool declares none. */
  price: Money.nullable(),
  credential: z.object({
    connectionKind: ConnectionKind.nullable(),
    downscope: DownscopeMethod,
  }),
  /** Paths into the call's input the gateway reads measures from. */
  measures: z.object({
    amount: z.string().nullable(),
    currency: z.string().nullable(),
    counterparty: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
  }),
  beltCount: Count,
  calls30d: Count,
});
export type ToolVersion = z.infer<typeof ToolVersion>;

export const Connection = z.object({
  id: PublicId,
  kind: ConnectionKind,
  name: z.string(),
  ownerId: PublicId,
  serverIds: z.array(ServerId),
  reviewedOn: Day,
  reviewOn: Day,
  grants30d: Count,
  status: z.enum(["active", "expired", "revoked"]),
  /** Whether a grant needs a mandate. Null until the mandate store lands (G1). */
  requiresMandate: z.boolean().nullable(),
  downscope: DownscopeMethod,
});
export type Connection = z.infer<typeof Connection>;

export const ObservedSchemaProposal = z.object({
  tool: z.string(),
  version: z.string(),
  /** JSON Schema 2020-12 inferred from observed outputs, as JSON text. */
  schema: z.string(),
  /** One observed output, as JSON text. */
  sample: z.string(),
  /** Per-property presence notes (`present in 318 of 341`). */
  notes: z.array(z.string()),
});
export type ObservedSchemaProposal = z.infer<typeof ObservedSchemaProposal>;

/** Where a kill switch acts (spec §6.11; `control.commands.target_kind`, plus an operator's agents). */
export const SwitchLevel = z.enum([
  "org",
  "workspace",
  "class",
  "tool_server",
  "tool_version",
  "connection",
  "agent",
  "operator",
]);
export type SwitchLevel = z.infer<typeof SwitchLevel>;

export const KillSwitch = z.object({
  id: PublicId,
  level: SwitchLevel,
  /** The slug, key, tool version, connection id, person id or class the switch names. */
  target: z.string(),
  on: z.boolean(),
  /** A class switch featured first on the page. */
  headline: z.boolean(),
  flippedById: PublicId.nullable(),
  flippedAt: Instant.nullable(),
  reason: z.string().nullable(),
  /** What flipping it stops, as counted when the page was read. */
  blastRadius: z.object({
    agents: Count.nullable(),
    toolVersions: Count.nullable(),
    mandates: Count.nullable(),
    runsInFlight: Count.nullable(),
    grants24h: Count.nullable(),
  }),
});
export type KillSwitch = z.infer<typeof KillSwitch>;

/** G12: auto-approval rules are mockup-only until the spec decides where they live. */
export const AutoApprovalRule = z.object({
  id: PublicId,
  name: z.string(),
  tool: ToolPattern,
  workspaceSlug: Slug,
  minTrust: z.number().int().min(0).max(1000).nullable(),
  minSpendScore: z.number().int().min(0).max(1000).nullable(),
  maxAmount: Money.nullable(),
  enabled: z.boolean(),
  createdById: PublicId,
  createdOn: Day,
  hits30d: Count,
  skipped30d: Count,
});
export type AutoApprovalRule = z.infer<typeof AutoApprovalRule>;

export const AssuranceResult = z.enum(["pass", "fail", "not_applicable"]);
export type AssuranceResult = z.infer<typeof AssuranceResult>;

export const AssuranceRun = z.object({
  suiteVersion: z.string(),
  ranAt: Instant,
  against: z.string(),
  passed: Count,
  failed: Count,
  notApplicable: Count,
  cases: z.array(
    z.object({ name: z.string(), result: AssuranceResult, detail: z.string() }),
  ),
});
export type AssuranceRun = z.infer<typeof AssuranceRun>;

// ---- Policy versions (G2, App. A.5 `tools.policy_versions`) -----------------

export const PolicyStatus = z.enum([
  "draft",
  "simulated",
  "active",
  "superseded",
]);
export type PolicyStatus = z.infer<typeof PolicyStatus>;

export const PolicyVersion = z.object({
  id: PublicId,
  version: z.number().int().positive(),
  status: PolicyStatus,
  authoredById: PublicId,
  authoredAt: Instant,
  ruleCount: Count,
  tests: z.object({ passed: Count, total: Count }),
  note: z.string(),
});
export type PolicyVersion = z.infer<typeof PolicyVersion>;

/** A draft replayed over recorded calls (spec §6.12). */
export const PolicySimulation = z.object({
  policyVersionId: PublicId,
  days: Count,
  calls: Count,
  wouldDeny: Count,
  wouldRequireApproval: Count,
  wasDeniedNowAllowed: Count,
  unchanged: Count,
  agentsAffected: z.array(z.string()),
});
export type PolicySimulation = z.infer<typeof PolicySimulation>;
