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
import { evaluateRules, requiredFactKeys } from "./evaluate";
import type { DecisionSubject, FactResolver, RuleSet, Verdict } from "./types";

/** A rule refused the call. `verdict.ruleId` is the audit citation. */
export class DecisionRuleDeniedError extends Error {
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
 * The auto-approval clause of the same rule set (ADR-068). The gate asks it
 * once, on a `require_approval` verdict: an outcome with `ok` has recorded
 * the approval as `policy:<rule id>` and the call proceeds; anything else
 * leaves the call with the person it was already going to.
 */
export type AutoApprovalHook = (args: {
  capability: string;
  input: unknown;
  ruleSet: RuleSet;
  verdict: Verdict;
  ctx: { orgId: string; workspaceId: string; userId: string | null };
}) => Promise<{ ok: boolean } | null>;

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

export interface DecisionGateArgs {
  capability: string;
  input: unknown;
  ctx: {
    orgId: string;
    workspaceId: string | null;
    userId: string | null;
    surface?: string;
    agentId?: string;
    requestId?: string;
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
  return async ({ capability, input, ctx, principal }) => {
    await judgeRules(options, { capability, input, ctx });
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
      return;
    }
    return options.checkMandate({
      capability,
      input,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentPrincipalId: principal.id,
      userId: ctx.userId,
      requestId: ctx.requestId,
    });
  };
}

/**
 * Whether an auto-approval rule answered the person's question for this call.
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
): Promise<boolean> {
  if (options.autoApprove === undefined || args.ctx.workspaceId === null) {
    return false;
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
      },
    });
    return outcome?.ok === true;
  } catch (error) {
    options.onError?.(error);
    return false;
  }
}

/** Evaluate the workspace's rule set; throws on a deny or a require_approval verdict. */
async function judgeRules(
  options: DecisionRulesGateOptions,
  {
    capability,
    input,
    ctx,
  }: Pick<DecisionGateArgs, "capability" | "input" | "ctx">,
): Promise<void> {
  let ruleSet: RuleSet | null;
  try {
    ruleSet = await options.loadRuleSet({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    });
  } catch (error) {
    options.onError?.(error);
    return;
  }
  if (ruleSet === null || ruleSet.rules.length === 0) return;

  let facts: Record<string, unknown> = {};
  const keys = requiredFactKeys(ruleSet, capability);
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
      // A dead fact source degrades those rules to no-match (their leaves
      // read absent keys); it does not skip evaluation — capability- and
      // input-shaped rules still bind.
      options.onError?.(error);
    }
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
  if (verdict === null || verdict.effect === "allow") return;
  if (verdict.effect === "require_approval") {
    if (
      await skipsThePerson(options, {
        capability,
        input,
        ctx,
        ruleSet,
        verdict,
      })
    ) {
      return;
    }
    throw new DecisionRuleApprovalRequiredError(verdict);
  }
  throw new DecisionRuleDeniedError(verdict);
}
