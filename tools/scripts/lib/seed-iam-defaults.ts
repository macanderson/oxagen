/**
 * Pure, testable core of tools/scripts/seed-iam-defaults.ts's Agent RBAC
 * phase (docs/specs/agent-rbac/spec.md §3.2, §3.3): the category/riskLevel
 * -> effect mapping for the three system agent roles, their resourceScope
 * ceilings, and the deterministic public_id generators. The runner wires
 * this to a real Postgres connection; everything here is DB-agnostic so it
 * can be unit-tested without a live database (mirrors the split used by
 * tools/scripts/lib/backfill-mcp-server-auth-config.ts).
 */
import { createHash } from "node:crypto";
import type { ResourceScopeCondition } from "@oxagen/oxagen/iam";
import type { RiskLevel } from "@oxagen/oxagen/types";

export type Effect = "allow" | "deny" | "require_approval";

// ── Agent RBAC system roles (docs/specs/agent-rbac/spec.md §3.2, §3.3) ────────
//
// Three SYSTEM agent roles — deliberately NOT four: spec.md §6 Q1 answer is
// explicit that this is pre-launch with zero customers, so no "Agent Legacy /
// unrestricted" back-compat role is seeded here.
//
// Unlike the human ORG_ROLES/WORKSPACE_ROLES grants (sourced from each
// contract's `defaultRoles`, a field keyed by the fixed SystemOrgRole /
// SystemWorkspaceRole union), these three roles have no `defaultRoles` entry
// — that type doesn't know about agent roles. Grants are instead computed
// from `contract.agent.{category,riskLevel}` (CapabilityAgentMetadata,
// packages/oxagen/src/types.ts), optional presentation metadata that only
// ~338 of the ~380 contracts declare (the ones relevant to the agent/chat
// surface). A capability with no `agent` block gets no role_grant row for
// any of the three roles and falls through to the contract's own
// `defaultEffect` (resolver rule 8) — unchanged behavior for all three roles
// alike, since such a capability was never agent-surface-relevant.
export const AGENT_ROLE_NAMES = [
  "Agent Observer",
  "Agent Contributor",
  "Agent Operator",
] as const;
export type AgentRoleName = (typeof AGENT_ROLE_NAMES)[number];

// `category` is a free-form per-contract string, not a fixed enum — a scan
// of packages/oxagen/src/contracts/*.ts turns up ~50 distinct values
// ("workspace", "skill", "schema", "plugin", "billing", "vcs", "execution",
// "write", "destructive", ...), most of which are domain names rather than
// a read/write axis. These four are the literal read-like categories named
// in the spec; every other category (including ones that are arguably safe
// reads, e.g. "workspace" covers workspace.list) is treated as non-read for
// Observer. That's intentional, not an oversight: Observer's stated intent
// is "read/answer only" (spec.md §3.2), so an ambiguous category is denied
// rather than allowed — err toward under-granting the most restrictive role.
export const READ_LIKE_CATEGORIES: ReadonlySet<string> = new Set([
  "read",
  "introspection",
  "graph",
  "memory",
]);

// Agent Operator's "except category=vcs/billing/security" carve-out
// (spec.md §3.2). No contract uses a literal "security" category — grep
// confirms zero matches across packages/oxagen/src/contracts/*.ts. The
// closest real equivalent is "secret" (secret.reveal, secret.value.set,
// secret.key.*, secret.export/import_env — all riskLevel "high", all about
// credential access, matching the CapabilitySensitivity doc comment's
// definition of "high": "irreversible writes or access to sensitive
// credentials"). Mapped here as the stand-in; revisit if a literal
// "security" category is introduced later.
export const OPERATOR_CARVEOUT_CATEGORIES: ReadonlySet<string> = new Set([
  "vcs",
  "billing",
  "secret",
]);

export function isReadLikeCategory(category: string): boolean {
  return READ_LIKE_CATEGORIES.has(category);
}

export interface AgentRoleSpec {
  name: AgentRoleName;
  description: string;
  /**
   * Wrapped as `{ resourceScope: <this> }` in `conditions_jsonb` on EVERY
   * role_grant row emitted for this role (not just one "anchor" row).
   * resolve.ts's collectResourceScope() intersects every resourceScope
   * found across a principal's role_grants regardless of which capability
   * it's attached to, so attaching the identical object to every row is
   * redundant-but-safe (a scope intersected with an identical copy of
   * itself is a no-op) rather than a source of drift, and avoids a single
   * point of failure if one particular grant row were ever pruned.
   */
  resourceScope: ResourceScopeCondition;
  computeEffect: (category: string, riskLevel: RiskLevel) => Effect;
}

export const AGENT_ROLE_SPECS: readonly AgentRoleSpec[] = [
  {
    name: "Agent Observer",
    description:
      "Read/answer only. Reads and graph/memory introspection allowed; every mutation denied. Graph access is capped to read mode; all MCP tool calls denied.",
    resourceScope: {
      graph: { mode: "read" },
      mcp: { rules: [{ pattern: "*", effect: "deny" }] },
    },
    computeEffect: (category) =>
      isReadLikeCategory(category) ? "allow" : "deny",
  },
  {
    name: "Agent Contributor",
    description:
      "Standard worker. Reads allowed; low/medium-risk mutations allowed; high-risk mutations require approval. No extra graph ceiling beyond the agent's own configured access; MCP tool calls require first-use consent (ask).",
    resourceScope: {
      mcp: { rules: [{ pattern: "*", effect: "ask" }] },
    },
    computeEffect: (category, riskLevel) => {
      if (isReadLikeCategory(category)) return "allow";
      return riskLevel === "high" ? "require_approval" : "allow";
    },
  },
  {
    name: "Agent Operator",
    description:
      'Trusted automation. Contributor posture plus high-risk mutations allowed, except vcs/billing/secret ("security") capabilities which stay at require_approval. Graph access may extend (write); MCP tool calls allowed.',
    resourceScope: {
      graph: { mode: "extend" },
      mcp: { rules: [{ pattern: "*", effect: "allow" }] },
    },
    computeEffect: (category, riskLevel) => {
      if (isReadLikeCategory(category)) return "allow";
      if (riskLevel !== "high") return "allow";
      // High-risk vcs/billing/secret capabilities are NOT widened to allow —
      // they keep Contributor's require_approval posture. This is an
      // explicit role_grant, not "no grant" (which would fall through to
      // the contract's own defaultEffect, e.g. "deny" for some of these):
      // Operator's posture on these should be auditable in role_grants
      // itself, not an emergent property of the fallback rule.
      return OPERATOR_CARVEOUT_CATEGORIES.has(category)
        ? "require_approval"
        : "allow";
    },
  },
];

/** rol_<sha256(orgId:scopeKind:name)[:22]> — MUST match
 * packages/handlers/src/iam-provision.ts's makeRolePublicId so a role
 * upserted from either path resolves to the same row. */
export function makeAgentRolePublicId(
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
// Shared by the human-role phase and the Agent RBAC phase alike (and MUST
// match packages/handlers/src/iam-provision.ts's makeRoleGrantPublicId).
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

/** Minimal capability shape this module needs — matches
 * CapabilityDeclaration's relevant subset without importing the whole type
 * (registry.ts's listCapabilities() return value is structurally assignable). */
export interface CapabilityLike {
  name: string;
  agent?: {
    category?: string;
    riskLevel?: RiskLevel;
  };
}

export interface CapabilityAgentMeta {
  name: string;
  category: string;
  riskLevel: RiskLevel;
}

/**
 * Filter the full capability list down to agent-surface-relevant entries
 * (those declaring an `agent` metadata block) and normalize the optional
 * `category`/`riskLevel` fields to their defaults. Pure — no I/O. A
 * capability with no `agent` block is intentionally excluded: see the
 * "Agent RBAC system roles" comment above.
 */
export function selectAgentCapabilities(
  capabilities: readonly CapabilityLike[],
): CapabilityAgentMeta[] {
  const result: CapabilityAgentMeta[] = [];
  for (const cap of capabilities) {
    if (!cap.agent) continue;
    result.push({
      name: cap.name,
      category: cap.agent.category ?? "",
      riskLevel: cap.agent.riskLevel ?? "medium",
    });
  }
  return result;
}
