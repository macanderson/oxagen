/**
 * The goal a rule-authoring turn is judged against (the in-app agent spec,
 * §5 slice 4 and §6; ADR-053, "It also authors rules that create
 * relationships in the knowledge graph between nodes sourced from several
 * connectors").
 *
 * A graph rule relates nodes that two different sources contributed: a
 * person from the CRM owns an account from billing. The turn that authors
 * one is done when the graph answers through it, not when the model says it
 * wrote something. So the goal names the proof: a `query_ontology` traversal
 * over the rule's relationship type, from a node of the first source, that
 * reaches a node of the second. The verifier judges the transcript against
 * that sentence and can call the graph reads itself to check it.
 *
 * Rule authoring has no page of its own today. The in-app turn is where a
 * rule is authored, with the schema and graph tools the belt holds, so this
 * goal is what a caller of `ask_assistant` sends when it asks for a rule.
 */
import {
  assistantGoalSchema,
  type AssistantGoal,
} from "@oxagen/oxagen/contracts/assistant.ask";

/** One end of a rule: the node label, and the source that contributes it. */
export interface GraphRuleEnd {
  /** The node label, e.g. `Person`. */
  label: string;
  /** The connector or source that contributes these nodes, e.g. `hubspot`. */
  source: string;
}

/** A relationship rule across two sources. */
export interface GraphRule {
  /** The relationship type the rule creates, e.g. `OWNS_ACCOUNT`. */
  relationshipType: string;
  start: GraphRuleEnd;
  end: GraphRuleEnd;
}

/** Rounds a rule-authoring turn takes: write the rule, then prove it. */
export const RULE_AUTHORING_ROUNDS = 3;

/**
 * The goal for a turn that authors `rule`. Validated against the contract's
 * goal schema, so a rule whose names would push the statement past the cap
 * is refused here rather than by the kernel after the turn was asked for.
 */
export function ruleAuthoringGoal(rule: GraphRule): AssistantGoal {
  const { relationshipType: type, start, end } = rule;
  const statement =
    `The relationship rule ${type} links ${start.label} nodes from ` +
    `${start.source} to ${end.label} nodes from ${end.source}, and a ` +
    `query_ontology traversal over ${type}, starting from a ${start.label} ` +
    `node from ${start.source}, returns a ${end.label} node from ` +
    `${end.source}. The rule is not done until that query has run and ` +
    `returned the node.`;
  return assistantGoalSchema.parse({
    statement,
    maxRounds: RULE_AUTHORING_ROUNDS,
  });
}
