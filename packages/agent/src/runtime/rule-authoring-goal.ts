/**
 * The goal a rule-authoring turn is judged against, and the instruction that
 * asks for the rule (the in-app agent spec, §5 slice 4 and §6; ADR-053, "It
 * also authors rules that create relationships in the knowledge graph between
 * nodes sourced from several connectors").
 *
 * A graph rule relates nodes that two different sources contributed: a
 * person from the CRM owns an account from billing. The turn that authors
 * one is done when the graph answers through it, not when the model says it
 * wrote something. So the goal names the proof: a `query_ontology` traversal
 * over the rule's relationship type, from a node of the first source, that
 * reaches a node of the second. The verifier judges the transcript against
 * that sentence and can call the graph reads itself to check it.
 *
 * The caller is `author_graph_rule` (ADR-182). Its handler builds both texts
 * here from the rule the caller named and sends them on one `ask_assistant`
 * turn, so the goal is written in one place and on the server. Rule authoring
 * has no page in the rev1 app, so the API and MCP reach it through that
 * capability.
 */
import {
  assistantGoalSchema,
  type AssistantGoal,
} from "@oxagen/oxagen/contracts/assistant.ask";
import type {
  GraphRule,
  GraphRuleEnd,
} from "@oxagen/oxagen/contracts/graph.rule.author";

export type { GraphRule, GraphRuleEnd };

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

/**
 * The message the model reads on a rule-authoring turn. It asks for the rule
 * and for the query the goal judges, so the worker and the verifier work to
 * the same test. The person's note follows, marked as theirs. The note adds
 * context and never changes the goal.
 */
export function ruleAuthoringInstruction(
  rule: GraphRule,
  note?: string,
): string {
  const { relationshipType: type, start, end } = rule;
  const lines = [
    `Author the relationship rule ${type} in this workspace's knowledge ` +
      `graph. It links ${start.label} nodes from ${start.source} to ` +
      `${end.label} nodes from ${end.source}.`,
    `Use the schema and graph tools you hold. When the rule is in place, run ` +
      `query_ontology over ${type} from a ${start.label} node from ` +
      `${start.source}, and name the ${end.label} node from ${end.source} ` +
      `it returns.`,
  ];
  if (note) lines.push(`The person's note: ${note}`);
  return lines.join("\n\n");
}
