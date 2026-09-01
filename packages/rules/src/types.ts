/**
 * The decision-rule vocabulary — what a workspace writes to govern which
 * business actions its agents may take on their own.
 *
 * A rule answers one question at one place: when an agent asks the kernel to
 * invoke a capability ("issue a refund", "send the customer a message"), may
 * it proceed, must a person approve first, or is it refused? The evaluation is
 * a pure function over three inputs — the capability name, the call's input
 * payload, and a bag of caller-resolved facts — so a verdict is reproducible
 * from the audit record that cites it.
 *
 * ## Why a condition tree and not a DSL string
 *
 * A string language needs a parser, an escaping story, and error positions,
 * and every one of those is a place a policy can mean something other than
 * what its author read. A JSON tree has none: it validates against a schema,
 * diffs cleanly in review, and renders directly in an authoring UI. This is
 * the shape IAM-style policy languages converge on, and the reason is theirs
 * too — a policy is data first and program second.
 *
 * ## Why facts are inputs, not lookups
 *
 * A rule like "at most 3 refunds per customer per 30 days" needs an aggregate
 * no input payload carries. The evaluator does not fetch it — it stays pure —
 * the GATE resolves the facts a rule set declares it needs (through the
 * `FactResolver` port) and hands them in. That split is what makes the
 * evaluator property-testable and a verdict replayable: record the facts with
 * the verdict and the decision re-derives byte-for-byte.
 */

/** Comparison operators a condition leaf may use. */
export const CONDITION_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "exists",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * One comparison. `fact` is a dot path into the evaluation subject:
 * `input.…` reaches into the capability call's payload, `facts.…` into the
 * resolver-supplied bag, and `call.capability` / `call.surface` /
 * `call.agent_id` into the call envelope. An unknown root never matches.
 */
export interface ConditionLeaf {
  fact: string;
  op: ConditionOp;
  /** Absent only for `exists`, which tests presence rather than value. */
  value?: unknown;
}

/**
 * The tree: `all` (conjunction), `any` (disjunction), `not` (negation), or a
 * leaf. Empty `all` is true and empty `any` is false — the identity elements,
 * so composing rule fragments programmatically never changes a verdict by
 * accident.
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | ConditionLeaf;

/**
 * What a matched rule decides.
 *
 * - `allow` — proceed, and stop evaluating (an explicit grant a later deny
 *   cannot override; put denies at higher priority when they must win).
 * - `deny` — refuse with the rule's reason.
 * - `require_approval` — a person must approve before the call proceeds. At a
 *   surface with no approval channel this enforces as deny, and the verdict
 *   says which rule asked, so the refusal reads as governance rather than
 *   breakage.
 */
export type RuleEffect = "allow" | "deny" | "require_approval";

export interface DecisionRule {
  /** Stable identifier, unique within the rule set. Cited by every verdict. */
  id: string;
  /** One sentence a reviewer reads; carried into the deny/approval message. */
  description: string;
  /**
   * Capability this rule governs: an exact registered name
   * (`issue_refund`) or a `*` suffix prefix-match (`refund_*`). `*` alone
   * matches every capability.
   */
  capability: string;
  /**
   * Evaluation order. Higher first; ties break on `id` (bytewise) so two
   * evaluations of one rule set can never disagree about order. Default 0.
   */
  priority?: number;
  /** Matches when the condition holds. Omitted means "always" for the capability. */
  when?: Condition;
  effect: RuleEffect;
  /**
   * Fact keys this rule reads under `facts.…`. Declared, not inferred, so the
   * gate knows what to resolve before evaluating — and so a rule reading a
   * fact nobody resolves is a validation error at publish time, not a silent
   * never-match in production.
   */
  requires_facts?: string[];
}

/** A workspace's rule set — the unit that is authored, versioned and loaded. */
export interface RuleSet {
  /** Wire/schema discriminator for forward compatibility. */
  schema: "oxagen.decision-rules.v1";
  rules: DecisionRule[];
}

/** The call under judgment. */
export interface DecisionSubject {
  capability: string;
  /** The capability call's input payload, as the handler would receive it. */
  input: unknown;
  /** Resolver-supplied aggregates and lookups, keyed as `requires_facts` names them. */
  facts: Record<string, unknown>;
  /** Envelope facts: reachable as `call.…` in conditions. */
  call?: {
    surface?: string;
    agent_id?: string;
    user_id?: string;
  };
}

/** The decision, always citing the rule that made it. */
export interface Verdict {
  effect: RuleEffect;
  ruleId: string;
  description: string;
}

/**
 * Resolves the facts a rule set declares. The gate calls it once per judged
 * invocation with the union of `requires_facts` across the candidate rules;
 * a resolver that cannot answer a key omits it, and conditions over the
 * missing key simply do not match (`exists` is how a rule asks "was this
 * resolvable at all").
 */
export type FactResolver = (args: {
  capability: string;
  input: unknown;
  keys: readonly string[];
  ctx: { orgId: string; workspaceId: string | null; userId: string | null };
}) => Promise<Record<string, unknown>>;
