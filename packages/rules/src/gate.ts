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

export interface DecisionRulesGateOptions {
  loadRuleSet: RuleSetLoader;
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
  };
}

export type DecisionRulesGateFn = (args: DecisionGateArgs) => Promise<void>;

/** Build the gate the bootstrap registers with the kernel. */
export function createDecisionRulesGate(
  options: DecisionRulesGateOptions,
): DecisionRulesGateFn {
  return async ({ capability, input, ctx }) => {
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
      throw new DecisionRuleApprovalRequiredError(verdict);
    }
    throw new DecisionRuleDeniedError(verdict);
  };
}
