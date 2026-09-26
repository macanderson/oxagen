/**
 * `author_graph_rule`: ask the in-app agent to author a relationship rule
 * across two sources, and judge the turn by whether the graph then answers
 * through the rule (ADR-186, ADR-177; the in-app agent spec, §5 slice 4).
 *
 * The caller names the rule as data: the relationship type, and the node
 * label and source at each end. The handler builds the turn from it on the
 * server. The instruction the model reads and the goal the verifier judges
 * both come from `ruleAuthoringGoal` and `ruleAuthoringInstruction` in
 * `@oxagen/agent`, so no caller writes, loosens, or forgets the acceptance
 * test. The turn itself is `ask_assistant`, invoked through the kernel with
 * that goal, so it keeps that contract's gates, run, receipts, and refusal
 * codes.
 *
 * `goalMet` reads the turn's end. The engine ends a goal-shaped turn
 * completed only when the verifier rules the goal met. A goal still unmet
 * after the last round fails the call with `engine_aborted`, and no output
 * comes back. So an answer with `stopped: false` is a met goal, and a stopped
 * turn ended before the verifier ruled it met. Each round's verdict and the
 * verifier's reasoning are on the run as `verification.goal_verdict` frames,
 * which `get_run` opens by `turn.runId`.
 *
 * Not on the `agent` surface: this starts an assistant turn, and the
 * assistant does not start its own turns. The rev1 app has no graph page
 * (apps/app/ARCHITECTURE.md §0 item 1: the `graph.*` capabilities stay on the
 * API and MCP), so no UI binds it yet.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { LABEL_PATTERN } from "../lib/label-pattern";
import { assistantAsk, assistantGoalSchema } from "./assistant.ask";
import { conversationPublicIdSchema } from "./conversation.list";
import { relationshipTypeNameSchema } from "./schema.types";

/**
 * A source slug: a connector's own slug (`hubspot`) or a plugin id
 * (`oxagen/hubspot`). Lowercase, so one source has one spelling in the goal
 * the verifier reads.
 */
export const GRAPH_RULE_SOURCE_PATTERN =
  /^[a-z0-9][a-z0-9_-]{0,62}(?:\/[a-z0-9][a-z0-9_-]{0,62})?$/;

/** The longest note a caller can add to the instruction. */
export const GRAPH_RULE_NOTE_MAX_CHARS = 4000;

/** One end of a rule: the node label, and the source that contributes it. */
export const graphRuleEndSchema = z
  .object({
    /** The node label, e.g. `Person`. */
    label: z
      .string()
      .regex(
        LABEL_PATTERN,
        "Label must start with a letter and hold letters, digits and underscores, at most 63",
      ),
    /** The connector or source that contributes these nodes, e.g. `hubspot`. */
    source: z
      .string()
      .regex(
        GRAPH_RULE_SOURCE_PATTERN,
        'Source must be a lowercase slug such as "hubspot" or "oxagen/hubspot"',
      ),
  })
  .strict();

/**
 * A relationship rule across two sources: `start` nodes from one source relate
 * to `end` nodes from another through `relationshipType`. The two sources
 * differ, because a relationship inside one source is a schema relationship,
 * which `upsert_schema_relationship` writes without a turn.
 */
export const graphRuleSchema = z
  .object({
    /** The relationship type the rule creates, e.g. `OWNS_ACCOUNT`. */
    relationshipType: relationshipTypeNameSchema,
    start: graphRuleEndSchema,
    end: graphRuleEndSchema,
  })
  .strict()
  .refine((rule) => rule.start.source !== rule.end.source, {
    message: "A graph rule relates nodes from two different sources",
    path: ["end", "source"],
  });

export const graphRuleAuthor = registerCapability({
  name: "author_graph_rule",
  domain: "graph",
  description:
    "Ask the in-app agent to author a relationship rule between nodes from two sources, as one assistant turn judged against a goal built from the rule: a query_ontology traversal over the relationship type, from a node of the first source, returns a node of the second. Returns the turn, the goal, and whether the verifier ruled it met.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  mutates: true,
  // The same terms as `ask_assistant`: the turn is not a governed action, and
  // each tool call inside it is one (ADR-053 §1, #2968 decision 3).
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "graph",
  },
  input: z
    .object({
      rule: graphRuleSchema,
      /**
       * What the person knows that the rule does not say, such as the
       * property the two ends share. Added to the instruction the model
       * reads. It never changes the goal.
       */
      note: z.string().trim().min(1).max(GRAPH_RULE_NOTE_MAX_CHARS).optional(),
      /**
       * The conversation to continue, as `ask_assistant` takes it. Null opens
       * a new conversation.
       */
      conversationId: z
        .union([z.string().uuid(), conversationPublicIdSchema])
        .nullable()
        .default(null),
      /** A key to stop the turn with `cancel_assistant_turn`. */
      turnId: z.string().uuid().optional(),
    })
    .strict(),
  output: z
    .object({
      /** The goal the turn was judged against, as the server built it. */
      goal: assistantGoalSchema,
      /**
       * True when the verifier ruled the goal met. False when the person
       * stopped the turn first. An unmet goal is a refusal, not an output.
       */
      goalMet: z.boolean(),
      /** The `ask_assistant` turn, whole: its run, reply and tool calls. */
      turn: assistantAsk.output,
    })
    .strict(),
});

export type GraphRule = z.output<typeof graphRuleSchema>;
export type GraphRuleEnd = z.output<typeof graphRuleEndSchema>;
export type GraphRuleAuthorInput = z.output<typeof graphRuleAuthor.input>;
export type GraphRuleAuthorOutput = z.output<typeof graphRuleAuthor.output>;
