/**
 * How Oxagen reads Cedar's answer (oxagen-agent-policy-spec, How a call is
 * decided).
 *
 * Cedar answers allow or deny and names the rules that decided. Oxagen parks
 * the call for a person when every rule that denied it carries
 * `@decision("require_approval")`, and denies it otherwise. A deny that names
 * no rule means no rule permitted the call, so it is a deny.
 *
 * An evaluation error fails closed: a rule that errors might have been the
 * forbid that applies, so the call is denied whatever the other rules say.
 */
import type { AuthorizationAnswer } from "@cedar-policy/cedar-wasm/nodejs";

export type CedarDecision = "allow" | "deny" | "require_approval";

export interface CedarVerdict {
  decision: CedarDecision;
  /** The ids of the rules that decided, sorted. Empty for a deny no rule permitted. */
  reasons: string[];
  /** Why the call could not be decided. A verdict with errors is always a deny. */
  errors: string[];
}

/** The annotation that marks a forbid as one a person's approval lifts. */
export const APPROVAL_ANNOTATION = "decision";
export const APPROVAL_VALUE = "require_approval";

export function readCedarDecision(
  answer: AuthorizationAnswer,
  approvalIds: ReadonlySet<string> | readonly string[],
): CedarVerdict {
  if (answer.type === "failure") {
    return { decision: "deny", reasons: [], errors: answer.errors.map((e) => e.message) };
  }
  const { decision, diagnostics } = answer.response;
  const reasons = [...diagnostics.reason].sort();
  if (diagnostics.errors.length > 0) {
    return {
      decision: "deny",
      reasons,
      errors: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`),
    };
  }
  if (decision === "allow") return { decision: "allow", reasons, errors: [] };
  const approval = approvalIds instanceof Set ? approvalIds : new Set(approvalIds);
  const parks = reasons.length > 0 && reasons.every((id) => approval.has(id));
  return { decision: parks ? "require_approval" : "deny", reasons, errors: [] };
}

const RANK: Readonly<Record<CedarDecision, number>> = { allow: 0, require_approval: 1, deny: 2 };

/** The stricter of two verdicts. A deny beats an approval, which beats an allow. */
export function stricterVerdict(a: CedarVerdict, b: CedarVerdict): CedarVerdict {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}
