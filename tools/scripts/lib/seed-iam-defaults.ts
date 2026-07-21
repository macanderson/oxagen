/**
 * Pure, testable core of the Agent RBAC system-role seed
 * (docs/specs/agent-rbac/spec.md §3.2).
 *
 * The runner (`tools/scripts/seed-iam-defaults.ts`) wires these to a real
 * Postgres connection; the logic here — role names/descriptions, the
 * category/riskLevel/requiresApproval → effect derivation, the resourceScope
 * ceiling per role, and the deterministic public_id helpers — is DB-agnostic
 * so it can be unit-tested without a live database. See the runner for the
 * SQL upsert/idempotency procedure.
 */
import { createHash } from "node:crypto";
import type { ResourceScope } from "@oxagen/oxagen/iam";

export type Effect = "allow" | "deny" | "require_approval";
export type RiskLevel = "low" | "medium" | "high";

// Exactly three system agent roles — no unrestricted/legacy fourth role.
// Pre-launch, there is no backwards-compatibility path (§6 open question 1
// answer: reset, not preserve).
export const AGENT_ROLE_NAMES = [
  "Agent Observer",
  "Agent Contributor",
  "Agent Operator",
] as const;
export type AgentRoleName = (typeof AGENT_ROLE_NAMES)[number];

export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRoleName, string> = {
  "Agent Observer":
    "Read/answer only. Reads (category: read, introspection, graph, memory) " +
    "are allowed; every mutation is denied. Graph access is forced to " +
    "mode='read'; all MCP tool calls are denied.",
  "Agent Contributor":
    "Standard worker. Reads are allowed; low/medium riskLevel mutations are " +
    "allowed; high riskLevel mutations require approval. Graph access is " +
    "as-configured by the agent definition (no extra ceiling); MCP tool " +
    "calls are asked per-tool on the servers the agent declares.",
  "Agent Operator":
    "Trusted automation. Contributor posture plus high riskLevel mutations " +
    "are allowed, EXCEPT vcs/billing/secret-category capabilities which " +
    "stay require_approval or deny per their own category metadata. Graph " +
    "access is as-configured including mode='extend'; MCP tool calls are " +
    "allowed on the servers the agent declares.",
};

// Categories treated as read/answer-only — allowed for every agent role,
// denied as mutations for Agent Observer.
export const READ_CATEGORIES: ReadonlySet<string> = new Set([
  "read",
  "introspection",
  "graph",
  "memory",
]);

// Categories that stay at Contributor's (never Operator's uncapped) posture
// even for Agent Operator — vcs/billing/security-sensitive capabilities.
// There is no "security" category in the registry; "secret" is the closest
// match (secret.key.*, secret.value.*, secret.export, secret.import_env).
export const OPERATOR_RESTRICTED_CATEGORIES: ReadonlySet<string> = new Set([
  "vcs",
  "billing",
  "secret",
]);

/** Agent RBAC resourceScope ceiling, identical across every grant row for a role. */
export const AGENT_ROLE_RESOURCE_SCOPE: Record<AgentRoleName, ResourceScope> = {
  "Agent Observer": {
    graph: { mode: "read" },
    mcp: { rules: [{ pattern: "*", effect: "deny" }] },
  },
  "Agent Contributor": {
    mcp: { rules: [{ pattern: "*", effect: "ask" }] },
  },
  "Agent Operator": {
    graph: { mode: "extend" },
    mcp: { rules: [{ pattern: "*", effect: "allow" }] },
  },
};

// A workspace-scoped, system-default role name matching this pattern is a
// stray back-compat/unrestricted role from a superseded spec draft (§6 open
// question 1: pre-launch, reset instead of migrate — no such role is ever
// seeded). Matched case-insensitively via SQL ILIKE by the runner; exported
// here too so tests can assert against the same literal.
export const LEGACY_ROLE_NAME_ILIKE_PATTERN = "Agent Legacy%";

/**
 * Contributor's mutation effect for a capability outside the read
 * categories: a contract that explicitly declares `requiresApproval: true`
 * always requires approval regardless of riskLevel — riskLevel alone is not
 * a substitute for a capability's own approval declaration (e.g. a
 * low-risk billing mutation that the contract still marks
 * `requiresApproval: true`). Otherwise: low/medium riskLevel allow, high
 * riskLevel (or undeclared — fail-closed) require_approval.
 */
export function contributorMutationEffect(
  riskLevel: RiskLevel | undefined,
  requiresApproval: boolean | undefined,
): Effect {
  if (requiresApproval === true) return "require_approval";
  if (riskLevel === "low" || riskLevel === "medium") return "allow";
  return "require_approval"; // riskLevel "high" or undeclared
}

/** Per-agent-role effect for one capability, derived from category/riskLevel. */
export function agentRoleEffect(
  roleName: AgentRoleName,
  category: string | undefined,
  riskLevel: RiskLevel | undefined,
  requiresApproval: boolean | undefined,
): Effect {
  const isRead = category !== undefined && READ_CATEGORIES.has(category);

  if (roleName === "Agent Observer") {
    return isRead ? "allow" : "deny";
  }

  if (isRead) return "allow";

  if (roleName === "Agent Contributor") {
    return contributorMutationEffect(riskLevel, requiresApproval);
  }

  // Agent Operator: Contributor posture, plus riskLevel=high allow — except
  // vcs/billing/secret categories, which stay at Contributor's posture. A
  // capability's own `requiresApproval: true` declaration is honored even
  // for Operator's uncapped riskLevel=high allow, since risk alone would
  // incorrectly grant access the contract itself gates on approval.
  const isOperatorRestricted =
    category !== undefined && OPERATOR_RESTRICTED_CATEGORIES.has(category);
  if (isOperatorRestricted) {
    return contributorMutationEffect(riskLevel, requiresApproval);
  }
  if (requiresApproval === true) return "require_approval";
  return riskLevel === "low" || riskLevel === "medium" || riskLevel === "high"
    ? "allow"
    : "require_approval"; // undeclared riskLevel — fail closed
}

/** rol_<sha256(orgId:scopeKind:name)[:22]> — matches iam-provision.ts. */
export function makeRolePublicId(
  orgId: string,
  scopeKind: "org" | "workspace",
  name: string,
): string {
  const digest = createHash("sha256")
    .update(`${orgId}:${scopeKind}:${name}`)
    .digest("hex")
    .slice(0, 22);
  return `rol_${digest}`;
}

// Generate a stable, collision-free public_id for a role_grant row.
// Deterministic so re-runs are idempotent against the public_id UNIQUE
// constraint. A previous version truncated the capability id to 14 chars,
// which collided for capabilities sharing a prefix (e.g.
// agent.task.background.{start,read,cancel}) and silently dropped grants.
export function makeRoleGrantPublicId(
  roleId: string,
  capabilityId: string,
): string {
  const digest = createHash("sha256")
    .update(`${roleId}:${capabilityId}`)
    .digest("hex")
    .slice(0, 24);
  return `rlg_${digest}`;
}
