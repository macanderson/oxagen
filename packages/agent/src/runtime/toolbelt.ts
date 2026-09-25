// toolbelt.ts — the per-tool decision the runtime and the console share.
//
// `materializeTools` builds the tool list a model is shown; `get_agent_toolbelt`
// reports that list without building it (MC spec §6.6, #2956). The two must
// agree on every tool, so the decision is one function here and both call it:
// the runtime drops a `deny` before it builds the tool, the console prints
// the rule that decided. A gate added to one side and not the other would be
// a belt the record shows and the model does not get, or the reverse.
//
// The capability gates, in the order the runtime applies them:
//   1. surface — the contract is on the agent surface;
//   2. exclusion — the turn withheld it (a UX narrowing, not governance);
//   3. allowlist — the run's or definition's tool allowlist;
//   4. risk ceiling — the workspace's risk policy;
//   5. agent run unresolved — an agent run without its resolution fails closed;
//   6. delegation ceiling — the resolver's agent ∩ human outcome (deny wins,
//      `pending_approval` stays visible and routes to approval at call time);
//   7. kill switch — an active emergency deny naming the capability. It
//      reaches an agent run through the run's principals, the in-app
//      assistant's turn through the agent it runs as, and any person's turn
//      through a deny that names no principal, as the per-call gate does;
//   8. entitlement — a plugin-claimed contract needs the plugin installed;
//   9. the contract's own `agent.requiresApproval`.
//
// MCP tools are decided by the run's effective `resourceScope.mcp` rules and
// the agent-subject consent ledger (`decideMcpToolForBelt`).
import type { ActiveEmergencyDeny } from "@oxagen/iam";
import { matchEmergencyDeny, resourceScopeDigestOf } from "@oxagen/iam";
import {
  resolveAgentRunCapability,
  type AgentRunIAMContext,
  type AgentRunIAMResolution,
  type EffectiveMcpScope,
  type EffectivePermissions,
  type McpRuleEffect,
  type ResolveScope,
} from "@oxagen/oxagen/iam";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { capabilityMutates } from "@oxagen/oxagen/types";
import type { RegistryCapability } from "../registry-loader";
import type { ActingAgent } from "./kill-switch-gate";

type BeltOutcome = "allow" | "require_approval" | "deny";

export interface BeltDecision {
  outcome: BeltOutcome;
  /** Which gate decided; `agent:<step>` / `human:<step>` name the resolver's deciding trace step. */
  rule: string;
  riskLevel: "low" | "medium" | "high";
  readOnly: boolean;
}

export interface CapabilityBeltEnv {
  /** Registry surfaces of the capability. */
  surfaces: readonly string[];
  excluded?: ReadonlySet<string>;
  allowlist?: ReadonlySet<string>;
  riskCeiling?: "low" | "medium" | "high";
  /** The run context, when the decision is for an agent principal. */
  agentRun: AgentRunIAMContext | null;
  /** The run's resolution; null with an agent run means fail closed. */
  resolution: AgentRunIAMResolution | null;
  scope: ResolveScope;
  now: Date;
  clientIp: string | null;
  /** Active emergency denies in scope; empty when none were read. */
  emergencyDenies: readonly ActiveEmergencyDeny[];
  /**
   * The agent a person's turn runs as (the in-app assistant), when there is
   * one. A deny naming its principal, or an `agent` switch on it, cuts the
   * tool. Ignored when `agentRun` is set.
   */
  actingAgent?: ActingAgent | null;
  /**
   * Plugin ids the org is entitled to, or `"unavailable"` when the read
   * failed (every plugin-claimed contract is then denied, fail closed).
   */
  entitledPluginIds: ReadonlySet<string> | "unavailable";
  /**
   * The person's IAM role names, read once per materialization (#4194).
   * Absent for an agent run, whose delegation ceiling already bounds it by
   * the invoking person's roles, and for a caller that reads none, such as
   * `get_agent_toolbelt`. `"unavailable"` when the read failed: every
   * capability is then out of the belt (fail closed).
   */
  callerRoles?: CallerRoles | "unavailable";
}

/** The org-wide and workspace role names a person holds. */
export interface CallerRoles {
  org: readonly string[];
  workspace: readonly string[];
}

/**
 * Whether the contract's `defaultRoles` grants `"allow"` to any role the
 * caller holds: an org role on the org side, or a workspace role on the
 * workspace side. This is the question the handler's role gate asks
 * (`assertOrgRole` over the contract's allowed roles), so the belt offers a
 * tool exactly when the handler would run it for this person.
 */
export function contractGrantsCaller(
  cap: RegistryCapability,
  roles: CallerRoles,
): boolean {
  const grants = cap.defaultRoles;
  if (!grants) return false;
  return (
    roles.org.some((role) => grants.org[role] === "allow") ||
    roles.workspace.some((role) => grants.workspace[role] === "allow")
  );
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

function riskLevelOf(cap: RegistryCapability): "low" | "medium" | "high" {
  return cap.agent?.riskLevel ?? "low";
}

/** The resolver step that decided the more restrictive side of the ceiling. */
function ceilingRule(perms: EffectivePermissions): string {
  const agentOutcome = perms.agentResolution.outcome;
  const humanOutcome = perms.humanResolution.outcome;
  const side =
    perms.outcome === agentOutcome && perms.outcome !== humanOutcome
      ? "agent"
      : perms.outcome === humanOutcome && perms.outcome !== agentOutcome
        ? "human"
        : "agent";
  const step =
    side === "agent"
      ? perms.agentResolution.trace.decidedBy.rule
      : perms.humanResolution.trace.decidedBy.rule;
  return `${side}:${step}`;
}

export function decideCapabilityForBelt(
  cap: RegistryCapability,
  env: CapabilityBeltEnv,
): BeltDecision {
  const riskLevel = riskLevelOf(cap);
  const readOnly = !capabilityMutates(cap);
  const deny = (rule: string): BeltDecision => ({
    outcome: "deny",
    rule,
    riskLevel,
    readOnly,
  });

  if (!env.surfaces.includes("agent")) return deny("surface");
  if (env.excluded?.has(cap.name)) return deny("excluded_this_turn");
  if (env.allowlist && !env.allowlist.has(cap.name)) return deny("allowlist");
  if (
    env.riskCeiling &&
    (RISK_ORDER[riskLevel] ?? 0) > (RISK_ORDER[env.riskCeiling] ?? 0)
  )
    return deny("risk_ceiling");

  // Role (#4194): a person's turn is offered only what their roles are
  // granted. The kernel's IAM check allows every capability for a
  // non-enterprise org, and each handler asks for the contract's roles
  // itself, so a tool outside them is one the person cannot run. Leaving it
  // on the belt offers stella a call that can only be refused. An agent run
  // keeps the delegation ceiling below instead.
  // A structural view with no role map has nothing to compare. Every
  // registered contract declares one, because `CapabilityDeclaration`
  // requires `defaultRoles`.
  if (
    env.agentRun === null &&
    env.callerRoles !== undefined &&
    cap.defaultRoles !== undefined
  ) {
    if (
      env.callerRoles === "unavailable" ||
      !contractGrantsCaller(cap, env.callerRoles)
    )
      return deny("role");
  }

  let outcome: BeltOutcome = "allow";
  let rule = "contract_default";
  if (env.agentRun !== null) {
    if (env.resolution === null) return deny("agent_run_unresolved");
    const perms = resolveAgentRunCapability(env.agentRun, env.resolution, {
      capability: cap.name,
      scope: env.scope,
      defaultEffect: cap.defaultEffect ?? "deny",
      now: env.now,
      clientIp: env.clientIp,
    });
    rule = ceilingRule(perms);
    if (perms.outcome === "deny") return deny(rule);
    if (perms.outcome === "pending_approval") outcome = "require_approval";
  }

  // The kill switch reaches every caller, not only an agent run. The in-app
  // assistant lists its tools as the person who asked (ADR-053 §1) and never
  // carries an agent run. While this check sat inside the agent-run branch, a
  // switched tool stayed on the assistant's belt and the per-call gate
  // refused every call to it (R4, #3370 finding 9). With no run, a person's
  // own turn has no principal ids, so only a deny that names no principal
  // matches. The assistant's turn also answers to the agent it runs as: a
  // deny naming that agent's principal, or an `agent` switch on it.
  // `createKillSwitchGate` matches each call on the same agent and principal,
  // but it reads kill switches only. A plain deny naming the principal, which
  // `set_kill_switch` never writes, is cut here and not refused per call.
  const run = env.agentRun;
  const acting = run === null ? (env.actingAgent ?? null) : null;
  const killed =
    env.emergencyDenies.length === 0
      ? null
      : matchEmergencyDeny(env.emergencyDenies, {
          capability: cap.name,
          principalIds:
            run !== null
              ? [
                  run.agentPrincipal.id,
                  ...(run.humanPrincipal ? [run.humanPrincipal.id] : []),
                ]
              : acting?.principalId
                ? [acting.principalId]
                : [],
          resourceScopeDigest: null,
          scopeDigests: acting
            ? [resourceScopeDigestOf({ kind: "agent", id: acting.agentId })]
            : [],
        });
  if (killed !== null) return deny("kill_switch");

  const plugin = pluginForContract(cap.name);
  if (plugin) {
    if (
      env.entitledPluginIds === "unavailable" ||
      !env.entitledPluginIds.has(plugin.id)
    )
      return deny("entitlement");
  }

  if (cap.agent?.requiresApproval === true) {
    outcome = "require_approval";
    rule = "contract_approval";
  }
  return { outcome, rule, riskLevel, readOnly };
}

interface McpBeltEnv {
  /** The run's effective MCP rule scope; undefined means unrestricted. */
  mcpScope: EffectiveMcpScope | undefined;
  /** The agent principal's standing consent for the tool, when recorded. */
  consent: { status: "granted" | "denied" } | null;
  /** The rule evaluation shared with the runtime bridge. */
  decide: (serverName: string, toolName: string) => McpRuleEffect;
}

/**
 * An MCP tool's belt decision: a `deny` rule hides it; an `ask` rule routes
 * it through the agent-subject consent ledger, so a standing grant allows it,
 * a standing denial hides it and no record means approval at first use.
 */
export function decideMcpToolForBelt(
  serverName: string,
  toolName: string,
  env: McpBeltEnv,
): BeltDecision {
  const base = { riskLevel: "medium" as const, readOnly: false };
  const effect = env.decide(serverName, toolName);
  if (effect === "deny") return { ...base, outcome: "deny", rule: "mcp_rule" };
  if (effect === "ask") {
    if (env.consent?.status === "granted")
      return { ...base, outcome: "allow", rule: "consent" };
    if (env.consent?.status === "denied")
      return { ...base, outcome: "deny", rule: "consent" };
    return { ...base, outcome: "require_approval", rule: "mcp_rule_ask" };
  }
  return {
    ...base,
    outcome: "allow",
    rule: env.mcpScope === undefined ? "mcp_unrestricted" : "mcp_rule",
  };
}
