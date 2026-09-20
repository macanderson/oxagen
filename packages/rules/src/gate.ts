/**
 * The kernel-facing half: turn a rule set and a fact resolver into the
 * decision gate `@oxagen/oxagen`'s kernel consults before running a handler.
 *
 * Mirrors the billing/budget admission gates exactly: the kernel takes an
 * injected function at bootstrap and knows nothing about this package; the
 * gate throws typed errors the surfaces can branch on. It fires AFTER IAM and
 * entitlement — a rule refines what an authorized caller may do, it never
 * substitutes for authorization — and BEFORE the handler, so a denied refund
 * never reaches the code that would have issued it.
 */
import type { DecisionSettlement, ResolvedPrincipal } from "@oxagen/oxagen";
import { inputDigest } from "./call-facts";
import { capabilityMatches, evaluateRules, requiredFactKeys } from "./evaluate";
import type {
  Condition,
  DecisionSubject,
  FactResolver,
  RuleSet,
  Verdict,
} from "./types";

/** A rule refused the call. `verdict.ruleId` is the audit citation. */
export class DecisionRuleDeniedError extends Error {
  readonly code = "decision_rule_denied";
  constructor(readonly verdict: Verdict) {
    super(
      `refused by decision rule "${verdict.ruleId}": ${verdict.description}`,
    );
    this.name = "DecisionRuleDeniedError";
  }
}

/**
 * A rule requires a person to approve first. A surface with an approval
 * channel catches this and opens its flow; one without treats it as a refusal
 * whose message says exactly which rule wants a human.
 */
export class DecisionRuleApprovalRequiredError extends Error {
  readonly code = "decision_rule_approval_required";
  approvalDigest?: string;
  constructor(readonly verdict: Verdict) {
    super(
      `decision rule "${verdict.ruleId}" requires approval: ${verdict.description}`,
    );
    this.name = "DecisionRuleApprovalRequiredError";
  }
}

/** How the gate loads the workspace's rules. Null means "no rule set" — every call proceeds. */
export type RuleSetLoader = (ctx: {
  orgId: string;
  workspaceId: string | null;
  externalTool?: boolean;
}) => Promise<RuleSet | null>;

/**
 * The mandate check the gate runs after the rules, for an agent principal
 * only (ADR-059 decision 4). It throws to refuse or park the call and
 * returns the settlement the kernel applies after the handler, or undefined
 * when no declared tool with a consequence tag is involved. Unlike the rule
 * set loader it never fails open: a mandate check that cannot run refuses
 * the call, because a consequential call with no verdict is the thing the
 * mandate exists to prevent.
 */
type MandateCheck = (args: {
  capability: string;
  input: unknown;
  orgId: string;
  workspaceId: string;
  agentPrincipalId: string;
  userId: string | null;
  requestId?: string;
}) => Promise<DecisionSettlement | undefined>;

/**
 * The auto-approval clause of the same rule set (ADR-070). The gate asks it
 * once, on a `require_approval` verdict, and the ask WRITES NOTHING: an
 * outcome with `ok` carries a `commit` the gate calls only once every later
 * check has cleared, in the caller's tenant scope. That order is the point — a mandate's own approval rule
 * runs after the rules and can still park the call, and a receipt saying
 * `policy:<rule id>` for a call a person was required to look at would invert
 * the one thing the `policy:` form is for.
 */
export type AutoApprovalHook = (args: {
  capability: string;
  input: unknown;
  ruleSet: RuleSet;
  verdict: Verdict;
  ctx: {
    orgId: string;
    workspaceId: string;
    userId: string | null;
    /**
     * The internal id (`agent_runs.id`) of the run this call belongs to, so
     * the receipt names the run the way `list_resolved_approvals` reads back
     * by (#3153). Null for a call with no run in scope: a person acting
     * under their own role, or a call parked before the in-app assistant's
     * turn opened one (the write path there threads its own run id through
     * a different seam; see materialize-tools.ts, #3370).
     */
    runId: string | null;
  };
}) => Promise<{ ok: boolean; commit?: () => Promise<void> } | null>;

export interface DecisionRulesGateOptions {
  loadRuleSet: RuleSetLoader;
  /** Omitted ⇒ every `require_approval` verdict goes to a person. */
  autoApprove?: AutoApprovalHook;
  /** Omitted ⇒ no mandate check; every agent call proceeds on the rules alone. */
  checkMandate?: MandateCheck;
  /** Omitted ⇒ rules that declare `requires_facts` see an empty bag and their fact conditions do not match. */
  resolveFacts?: FactResolver;
  /**
   * Where a load/resolve failure is reported. The gate FAILS OPEN on its own
   * infrastructure: a broken rules loader must degrade to "no opinion", never
   * take every agent action in the workspace down with it — the same posture
   * as the workspace budget-governance read. It never fails open on a rule
   * that evaluated: a verdict, once computed, is enforced.
   */
  onError?: (error: unknown) => void;
}

export class ExternalToolAuthorityError extends Error {
  readonly code = "external_tool_authority_unavailable";
}

export interface DecisionGateArgs {
  external?: { approvedDigest?: string };
  capability: string;
  input: unknown;
  ctx: {
    orgId: string;
    workspaceId: string | null;
    userId: string | null;
    surface?: string;
    agentId?: string;
    requestId?: string;
    /** The internal id (`agent_runs.id`) of the run this call belongs to; null or absent when none is in scope. */
    runId?: string | null;
  };
  /** The IAM-resolved acting principal; the mandate check runs for `kind: "agent"`. */
  principal?: ResolvedPrincipal | null;
}

export type DecisionRulesGateFn = (
  args: DecisionGateArgs,
) => Promise<void | DecisionSettlement>;

/** Build the gate the bootstrap registers with the kernel. */
export function createDecisionRulesGate(
  options: DecisionRulesGateOptions,
): DecisionRulesGateFn {
  return async ({ capability, input, ctx, principal, external }) => {
    if (external && principal?.kind === "agent") {
      throw new ExternalToolAuthorityError(
        "External tool measures cannot establish an agent mandate. Use a governed capability with declared measures.",
      );
    }
    // The rules decide first, and an auto-approval they release is only
    // EVALUATED here: `commit` writes the receipt, and it is called at the
    // end, once nothing later can still send the call to a person.
    const commit = await judgeRules(options, {
      capability,
      input,
      ctx,
      external,
    });
    // The mandate check binds an agent acting under delegated authority; a
    // person under their own role needs no mandate (spec §6.9 part 3), and
    // the check needs a workspace to read the tool registry from.
    if (
      options.checkMandate === undefined ||
      principal === undefined ||
      principal === null ||
      principal.kind !== "agent" ||
      ctx.workspaceId === null
    ) {
      await record(options, commit);
      return;
    }
    // Throws to refuse or to park; either way the receipt is never written.
    const settlement = await options.checkMandate({
      capability,
      input,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentPrincipalId: principal.id,
      userId: ctx.userId,
      requestId: ctx.requestId,
    });
    // By here the mandate has reserved authority in the ledger, and the only
    // thing that gives it back is the settlement the kernel applies to the
    // settlement this gate RETURNS. A throw from here never returns it, so
    // the reservation would sit open forever: no approval row names the call,
    // so neither the expiry sweep nor a revoke would ever find it, and the
    // mandate's remaining authority would shrink on every failed call. The
    // release happens here instead, before the failure propagates.
    try {
      await record(options, commit);
    } catch (error) {
      await releaseReservation(options, settlement);
      throw error;
    }
    return settlement;
  };
}

/** What a released call still owes: the receipt saying no person looked. */
type AutoApprovalCommit = (() => Promise<void>) | undefined;

/**
 * Whether an auto-approval rule answered the person's question for this call,
 * and what writing that answer down will take.
 *
 * Needs a workspace: the rules are a workspace's. A hook that throws is
 * infrastructure failing, and the gate's posture there is unchanged — the
 * call goes to the person the verdict already sent it to, which is the safe
 * direction, so the error is reported and swallowed rather than allowed to
 * release the call.
 */
async function skipsThePerson(
  options: DecisionRulesGateOptions,
  args: {
    capability: string;
    input: unknown;
    ctx: DecisionGateArgs["ctx"];
    ruleSet: RuleSet;
    verdict: Verdict;
  },
): Promise<AutoApprovalCommit> {
  if (options.autoApprove === undefined || args.ctx.workspaceId === null) {
    return undefined;
  }
  try {
    const outcome = await options.autoApprove({
      capability: args.capability,
      input: args.input,
      ruleSet: args.ruleSet,
      verdict: args.verdict,
      ctx: {
        orgId: args.ctx.orgId,
        workspaceId: args.ctx.workspaceId,
        userId: args.ctx.userId,
        runId: args.ctx.runId ?? null,
      },
    });
    if (outcome?.ok !== true) return undefined;
    // A hook that says ok and hands back nothing to write would release the
    // call with no receipt; the person looks instead.
    return outcome.commit;
  } catch (error) {
    options.onError?.(error);
    return undefined;
  }
}

/**
 * Give back what a mandate reserved for a call that is not going to happen.
 *
 * Reported and swallowed: it runs while another error is already on its way
 * up, and losing that error to a secondary failure would hide why the call
 * was refused. The same posture `applyDecisionSettlement` takes in the kernel.
 */
async function releaseReservation(
  options: DecisionRulesGateOptions,
  settlement: void | DecisionSettlement,
): Promise<void> {
  if (!settlement) return;
  try {
    await settlement.release();
  } catch (error) {
    options.onError?.(error);
  }
}

/**
 * Write the receipt for a call the rules released, now that nothing later can
 * still send it to a person.
 *
 * A commit that fails does not release the call: the `policy:<rule id>` row IS
 * the authority for skipping the human, so a decision that cannot be recorded
 * is a decision that did not happen, and the call goes to the person the
 * verdict sent it to.
 */
async function record(
  options: DecisionRulesGateOptions,
  commit: AutoApprovalCommit,
): Promise<void> {
  if (commit === undefined) return;
  try {
    await commit();
  } catch (error) {
    options.onError?.(error);
    throw new DecisionRuleApprovalRequiredError({
      effect: "require_approval",
      ruleId: "auto_approval_not_recorded",
      description:
        "an auto-approval rule released this call and the approval could not be recorded",
    });
  }
}

function conditionFacts(condition: Condition | undefined): string[] {
  if (!condition) return [];
  if ("all" in condition) return condition.all.flatMap(conditionFacts);
  if ("any" in condition) return condition.any.flatMap(conditionFacts);
  if ("not" in condition) return conditionFacts(condition.not);
  return condition.fact.startsWith("facts.") ? [condition.fact.slice(6)] : [];
}

/**
 * Evaluate the workspace's rule set; throws on a deny, and on a
 * require_approval verdict no auto-approval rule released. Returns the
 * receipt one did release still owes, or undefined when nothing is owed.
 */
async function judgeRules(
  options: DecisionRulesGateOptions,
  {
    capability,
    input,
    ctx,
    external,
  }: Pick<DecisionGateArgs, "capability" | "input" | "ctx" | "external">,
): Promise<AutoApprovalCommit> {
  let ruleSet: RuleSet | null;
  try {
    ruleSet = await options.loadRuleSet({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      ...(external ? { externalTool: true } : {}),
    });
  } catch (error) {
    if (external) throw error;
    options.onError?.(error);
    return undefined;
  }
  if (ruleSet === null || ruleSet.rules.length === 0) return undefined;

  let facts: Record<string, unknown> = {};
  const keys = [
    ...new Set([
      ...requiredFactKeys(ruleSet, capability),
      ...(external
        ? ruleSet.rules
            .filter((rule) => capabilityMatches(rule.capability, capability))
            .flatMap((rule) => conditionFacts(rule.when))
        : []),
    ]),
  ];
  if (external && keys.length > 0 && !options.resolveFacts)
    throw new ExternalToolAuthorityError("External rule facts are unavailable");
  if (keys.length > 0 && options.resolveFacts) {
    try {
      facts = await options.resolveFacts({
        capability,
        input,
        keys,
        ctx: {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        },
      });
    } catch (error) {
      if (external) throw error;
      // A dead fact source degrades those rules to no-match (their leaves
      // read absent keys); it does not skip evaluation — capability- and
      // input-shaped rules still bind.
      options.onError?.(error);
    }
  }

  if (
    external &&
    keys.some(
      (key) =>
        key
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value !== null && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            facts,
          ) === undefined,
    )
  ) {
    throw new ExternalToolAuthorityError("External rule facts are incomplete");
  }

  const subject: DecisionSubject = {
    capability,
    input,
    facts,
    call: {
      surface: ctx.surface,
      agent_id: ctx.agentId,
      user_id: ctx.userId ?? undefined,
    },
  };
  const verdict = evaluateRules(ruleSet, subject);
  if (verdict === null || verdict.effect === "allow") return undefined;
  if (verdict.effect === "require_approval") {
    if (external) {
      const digest = inputDigest({
        capability,
        input,
        rules: ruleSet.rules,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        orgId: ctx.orgId,
      });
      if (external.approvedDigest === digest) return undefined;
      const required = new DecisionRuleApprovalRequiredError(verdict);
      required.approvalDigest = digest;
      throw required;
    }
    const commit = await skipsThePerson(options, {
      capability,
      input,
      ctx,
      ruleSet,
      verdict,
    });
    if (commit !== undefined) return commit;
    throw new DecisionRuleApprovalRequiredError(verdict);
  }
  throw new DecisionRuleDeniedError(verdict);
}
