// Shared view-model enums and scalars, in the spec's vocabulary (spec App. A),
// never the mockup's strings. The fixture adapter maps mockup values onto these
// once; every page, port and adapter reads these names.
import { z } from "zod";

/** A public id: a lowercase kind prefix, an underscore, then a base-62 body (`run_01K5RS…`). */
export const PublicId = z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/);
export type PublicId = z.infer<typeof PublicId>;

/** ISO 4217 currency code. */
export const Currency = z.string().length(3);
export type Currency = z.infer<typeof Currency>;

/** Where a cost figure came from. A number never reads stronger than its basis. */
export const CostBasis = z.enum([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);
export type CostBasis = z.infer<typeof CostBasis>;

/**
 * Money on the wire: integer micro-units as a decimal string. Never a float and
 * never a display string like "2,450.00", which silently becomes 0 or 2 under
 * parseFloat. Formatting happens only in the `<Money>` component.
 */
export const Money = z.object({
  micros: z.string().regex(/^-?\d+$/),
  currency: Currency,
  basis: CostBasis.optional(),
});
export type Money = z.infer<typeof Money>;

export const EnforcementTier = z.enum(["gateway", "harness", "observe"]);
export type EnforcementTier = z.infer<typeof EnforcementTier>;

export const ReplayGrade = z.enum(["inspect", "view", "fork", "retry"]);
export type ReplayGrade = z.infer<typeof ReplayGrade>;

export const Verdict = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
  "none",
]);
export type Verdict = z.infer<typeof Verdict>;

export const Risk = z.enum(["low", "medium", "high", "critical"]);
export type Risk = z.infer<typeof Risk>;

export const SideEffect = z.enum(["read", "write", "irreversible"]);
export type SideEffect = z.infer<typeof SideEffect>;

export const EgressClass = z.enum(["local", "org_tenant", "third_party"]);
export type EgressClass = z.infer<typeof EgressClass>;

/**
 * Steering record kinds: the six real kinds Stella's `RecordKind` and the mockup
 * carry (plan §6 Q5). The spec's "twelve kinds" is a spec defect to correct.
 */
export const RecordKind = z.enum([
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);
export type RecordKind = z.infer<typeof RecordKind>;

// ---- Scalars shared by every domain ----------------------------------------

/** A UTC instant, `2026-09-11T09:14:02Z` (fractional seconds allowed). */
export const Instant = z.iso.datetime();
export type Instant = z.infer<typeof Instant>;

/** A calendar day, `2026-09-11`. */
export const Day = z.iso.date();
export type Day = z.infer<typeof Day>;

export const Count = z.number().int().nonnegative();
export type Count = z.infer<typeof Count>;

/** A share between 0 and 1 (cache hit rate, productive ratio, recall). */
export const Ratio = z.number().min(0).max(1);
export type Ratio = z.infer<typeof Ratio>;

/** A URL segment: organization and workspace slugs. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type Slug = z.infer<typeof Slug>;

/** An agent's immutable key, `org_ns.ws_ns.slug` (spec §3, ADR-024). */
export const AgentKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/);
export type AgentKey = z.infer<typeof AgentKey>;

/** One tool version, `name@version` (`github__create_release@2`). */
export const ToolVersionRef = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*@[0-9][0-9.]*$/);
export type ToolVersionRef = z.infer<typeof ToolVersionRef>;

/** A tool name or glob with an optional version glob (`github__*@*`, `linear__*`). */
export const ToolPattern = z
  .string()
  .regex(/^[A-Za-z*][A-Za-z0-9_*]*(@[0-9*][0-9.*]*)?$/);
export type ToolPattern = z.infer<typeof ToolPattern>;

/** A content digest. Display digests may be truncated with an ellipsis. */
export const Digest = z.string().regex(/^sha256:[0-9a-f]+(…[0-9a-f]*)?$/);
export type Digest = z.infer<typeof Digest>;

/** A git commit, abbreviated or full. */
export const CommitSha = z.string().regex(/^[0-9a-f]{7,40}$/);
export type CommitSha = z.infer<typeof CommitSha>;

// ---- Identity ----------------------------------------------------------------

export const PrincipalKind = z.enum(["human", "agent", "service"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

/** `iam.principals.harness` (App. A.4). */
export const Harness = z.enum([
  "stella",
  "claude-code",
  "codex-cli",
  "openai-agents-sdk",
  "claude-agent-sdk",
  "custom",
  "oxagen-service",
]);
export type Harness = z.infer<typeof Harness>;

/** `org.org_users.role` (App. A.2). */
export const OrgRole = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);
export type OrgRole = z.infer<typeof OrgRole>;

/** `wrk.workspace_users.role` (App. A.3). */
export const WorkspaceRole = z.enum(["owner", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/** How a person or an agent is drawn. Tones come from the house scale only. */
export const AvatarTone = z.enum(["solid", "soft", "line"]);
export const Avatar = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("icon"),
    icon: z.string().regex(/^[a-z0-9-]+$/),
    tone: AvatarTone,
  }),
  z.object({
    kind: z.literal("initials"),
    text: z.string().min(1).max(3),
    font: z.enum(["sans", "serif", "mono"]),
    tone: AvatarTone,
  }),
  z.object({ kind: z.literal("photo"), src: z.string().min(1) }),
]);
export type Avatar = z.infer<typeof Avatar>;

// ---- Governance vocabulary ---------------------------------------------------

/**
 * A consequence tag (spec §6.9): the starter set plus any tag a customer
 * defines, so the schema accepts any snake_case tag.
 */
export const ConsequenceTag = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ConsequenceTag = z.infer<typeof ConsequenceTag>;
export const STARTER_CONSEQUENCE_TAGS = [
  "moves_money",
  "destroys_data",
  "alters_production",
  "communicates_externally",
  "changes_access",
  "changes_entitlement",
] as const;

/** `tools.tool_versions.schema_origin` (App. A.5). */
export const SchemaOrigin = z.enum([
  "declared",
  "imported",
  "observed_proposed",
  "observed_approved",
]);
export type SchemaOrigin = z.infer<typeof SchemaOrigin>;

/** `iam.role_grants.effect` (App. A.4). */
export const GrantEffect = z.enum(["allow", "deny", "require_approval"]);
export type GrantEffect = z.infer<typeof GrantEffect>;

/** `control.tool_calls.decision` (App. A.6). */
export const CallDecision = z.enum(["allow", "approve", "deny"]);
export type CallDecision = z.infer<typeof CallDecision>;

/** `audit.audit_events.severity` (App. A.9): 1, 3 or 10. */
export const Severity = z.union([z.literal(1), z.literal(3), z.literal(10)]);
export type Severity = z.infer<typeof Severity>;

/** Model routing tiers (spec §4.5). */
export const ModelTier = z.enum(["light", "complex"]);
export type ModelTier = z.infer<typeof ModelTier>;
