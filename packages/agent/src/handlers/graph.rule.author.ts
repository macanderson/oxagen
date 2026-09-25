// author_graph_rule: one `ask_assistant` turn that authors a relationship rule
// across two sources, judged by whether the graph then answers through it
// (ADR-183, ADR-177).
//
// The handler writes nothing itself. It checks the person may ask, builds the
// instruction and the goal from the rule on the server, and invokes
// `ask_assistant` through the kernel with both. That nested invoke runs the
// turn's own gates, records the turn as its run, and writes each round's
// verdict as a `verification.goal_verdict` frame before the seal. The turn
// still runs outside any governed-action frame (`assistant.ask.ts`), so every
// tool call inside it is a governed action of its own (ADR-053 §1).
//
// Refusals pass through with their own codes: `engine_aborted` when the goal
// is still unmet after the last round, `engine_unavailable`,
// `assistant_run_not_recorded`, the credit gate's codes, and the turn's
// `not_found` and `forbidden` reasons.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import {
  assistantAsk,
  type AssistantAskInput,
  type AssistantAskOutput,
} from "@oxagen/oxagen/contracts/assistant.ask";
import {
  graphRuleAuthor,
  type GraphRuleAuthorInput,
  type GraphRuleAuthorOutput,
} from "@oxagen/oxagen/contracts/graph.rule.author";
import { invoke } from "@oxagen/oxagen/kernel";
import {
  ruleAuthoringGoal,
  ruleAuthoringInstruction,
} from "../runtime/rule-authoring-goal";
import type { CapabilityContext } from "../types";

/**
 * The roles the contract grants, checked here for every tier (INV-29). The
 * kernel's IAM check allows every capability for a non-enterprise
 * organization, so the contract's roles hold only where a handler asserts
 * them.
 */
const RULE_ROLES = {
  org: allowedRoles(graphRuleAuthor.defaultRoles.org),
  workspace: allowedRoles(graphRuleAuthor.defaultRoles.workspace),
};

function allowedRoles(grants: Record<string, string | undefined>): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

export async function graphRuleAuthorHandler(
  input: GraphRuleAuthorInput,
  ctx: CapabilityContext,
): Promise<GraphRuleAuthorOutput> {
  // The person asking: the signed-in user, or the creator of the API key.
  // Refused before the turn is asked for, so a caller without the role
  // starts nothing.
  const userId = await resolveActingUserId(ctx);
  if (userId === null) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  await assertOrgRole({ ...ctx, userId }, RULE_ROLES);

  const goal = ruleAuthoringGoal(input.rule);
  const turnInput: AssistantAskInput = {
    conversationId: input.conversationId,
    content: ruleAuthoringInstruction(input.rule, input.note),
    pageContext: null,
    goal,
    ...(input.turnId ? { turnId: input.turnId } : {}),
  };
  const turn = (await invoke(
    assistantAsk.name,
    turnInput,
    ctx,
  )) as AssistantAskOutput;

  // The engine ends a goal-shaped turn completed only on a met verdict, and
  // refuses with `engine_aborted` when the rounds run out first. A stopped
  // turn ended before the verifier ruled it met.
  return { goal, goalMet: !turn.stopped, turn };
}
