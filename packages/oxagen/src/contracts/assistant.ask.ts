/**
 * `ask_assistant`: one turn of the in-app agent (MC spec App. E, §4.4, §14.1;
 * ADR-053). The person's message is appended to a conversation, the turn is
 * admitted as a run of its own in the evidence ledger, the engine
 * (`stella-serve`) drives it with every completion and tool call answered by
 * Oxagen, and the reply is persisted as the assistant's message.
 *
 * `mode: "async"`: the API streams the turn over its SSE route,
 * `POST /v1/:org/:ws/chat/stream`, whose body is this contract's input and
 * whose terminal `done` carries this contract's output. The apps/app flyout
 * does not stream: its server action makes one `kernelWrite` call and
 * receives the output whole, as the API's `ask_assistant` route and the MCP
 * tool do.
 *
 * The SSE route invokes this contract through the kernel too, so the gates
 * below are the same on every adapter.
 *
 * Refusals a caller can act on arrive with their own code:
 * `engine_unavailable` (the engine is down; nothing falls back to an
 * in-process loop, ADR-053 §4), `assistant_run_not_recorded` (the ledger
 * could not admit the turn or a receipt could not be written; the assistant
 * does not answer from a path that was not recorded), `engine_aborted` (the
 * turn was cancelled before it answered), and the credit gate's codes. A
 * governed write the turn opened that is waiting on a person is returned as
 * the parked card, and the turn still completes.
 *
 * A turn the person stops is not a refusal. When the caller passed `turnId`
 * and `cancel_assistant_turn` names it, the turn returns with `stopped: true`
 * and whatever reply the engine had written, and the run is sealed
 * `cancelled`. A disconnect and a budget stop still refuse with
 * `engine_aborted`.
 *
 * The turn is not a governed action (`noBillingGate`, #2968 decision 3): the
 * run is free to the customer and never appears in `list_runs`; `runId` opens
 * it through `get_run`. Each tool call inside it is a top-level governed
 * action through `kernel.invoke()` (ADR-053 §1), and the turn's tokens are
 * metered on the organisation's funding source (ADR-053 §3).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { CHAT_CONTENT_MAX_CHARS } from "./chat.message.send";
import { conversationPublicIdSchema } from "./conversation.list";

/**
 * The longest record label a page context carries, in UTF-16 code units.
 *
 * The label is the name the page drew for its record. 256 holds these
 * sources whole: a runtime's hostname (253, the DNS limit
 * `create_tacho_enrollment` enforces), a steering record's title (200), an
 * agent's name (128), and a run's generated name or derived title (80). Three
 * sources run longer: a mandate's purpose (2,000), which the Mandate page
 * uses because a mandate has no name, and the title a harness gives its own
 * session and a ledger run's task reference, which have no cap where they are
 * written. Past 256 characters a label is prose rather than a name. The app
 * cuts a longer label to this length before it sends one, and the contract
 * refuses a longer one from any other caller, because the turn puts the label
 * in a line the model reads as system context.
 */
export const ASSISTANT_ENTITY_LABEL_MAX = 256;

/** Where the person was when they asked: the route key and the tenant slugs. */
export const assistantPageContextSchema = z
  .object({
    /** The app's route key for the page (`fleet`, `run`, `billing`, …). */
    route: z.string().min(1).max(64),
    orgSlug: z.string().min(1).max(128),
    workspaceSlug: z.string().min(1).max(128),
    /** The record on the page, when there is one (a run id, an agent key). */
    entityId: z.string().min(1).max(256).nullable().default(null),
    /**
     * The record's name as the page drew it (a run's title, a runtime's
     * hostname), beside `entityId`. Untrusted: an agent or a person wrote it.
     * The turn strips its control characters and quotes it as a label, and
     * ignores it when `entityId` is null.
     */
    entityLabel: z
      .string()
      .min(1)
      .max(ASSISTANT_ENTITY_LABEL_MAX)
      .nullable()
      .default(null),
  })
  .strict();

/**
 * The longest goal statement a turn accepts. The engine writes the statement
 * into every working round's kickoff and feedback message and into each
 * verifier call's instruction, so it is paid for once per round on both
 * tiers. A goal is the test the result must pass, not a second instruction:
 * the instruction already has 32 KiB. 2,000 characters holds an acceptance
 * test with room to spare and records whole under the run spec's 8,192.
 */
export const ASSISTANT_GOAL_MAX_CHARS = 2000;

/**
 * The most working rounds a goal-shaped turn may take. Each round is a whole
 * turn (up to 12 steps) plus a verifier call (up to 8 steps), and a person is
 * waiting on the reply. The engine defaults to 8 rounds and clamps at 32;
 * 4 bounds the in-app worst case at 48 worker steps.
 */
export const ASSISTANT_GOAL_MAX_ROUNDS = 4;

/**
 * What an independent verifier judges the turn against (`GoalSpec` in
 * `stella-serve/src/routes.rs`). The turn keeps working until the verifier
 * says the goal is met or the rounds run out, and each verdict is recorded
 * on the run as `verification.goal_verdict`.
 */
export const assistantGoalSchema = z
  .object({
    /** The condition the result must meet, stated so a verifier can check. */
    statement: z.string().trim().min(1).max(ASSISTANT_GOAL_MAX_CHARS),
    /** Working rounds before the turn gives up; 1 to 4, 3 when omitted. */
    maxRounds: z
      .number()
      .int()
      .min(1)
      .max(ASSISTANT_GOAL_MAX_ROUNDS)
      .default(3),
  })
  .strict();

/** A governed write the turn opened that is waiting on a person. */
export const assistantParkedCardSchema = z
  .object({
    /** The approval's public id (`apr_…`), the row `resolve_approval` takes. */
    approvalId: z.string().min(1),
    /** The capability the parked call asked for. */
    capability: z.string().min(1),
    /** RFC 3339: when the approval expires unresolved. */
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const assistantAsk = registerCapability({
  name: "ask_assistant",
  domain: "assistant",
  description:
    "Take one turn with the in-app agent: append the message to a conversation, record the turn as a run of its own, drive it on the assistant engine with every completion and tool call answered by Oxagen, and return the reply with the run it was recorded as.",
  mode: "async",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
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
    category: "conversation",
  },
  input: z
    .object({
      /**
       * The conversation to continue, by its `cnv_` public id (what
       * `list_conversations` and `get_conversation` return, and what
       * `conversationPublicId` below carries) or by the internal id this
       * output has always carried. Null opens a new conversation.
       */
      conversationId: z
        .union([z.string().uuid(), conversationPublicIdSchema])
        .nullable()
        .default(null),
      /** 1 to 32 KiB: the cap every chat ingress shares. */
      content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
      /** Null when the caller has no page (the API, MCP). */
      pageContext: assistantPageContextSchema.nullable().default(null),
      /**
       * Omitted runs one ordinary turn. Present, the engine judges the result
       * against it (ADR-177). Set by the caller, never by the model: this
       * contract is not on the agent surface.
       */
      goal: assistantGoalSchema.optional(),
      /**
       * A key the caller mints before it asks, so it can stop the turn with
       * `cancel_assistant_turn` while this call is still waiting. Omitted, the
       * turn can still end on a disconnect or a budget stop, but nobody can
       * stop it by name.
       */
      turnId: z.string().uuid().optional(),
    })
    .strict(),
  output: z
    .object({
      conversationId: z.string().uuid(),
      /**
       * `cnv_…`: the same conversation by the public id every conversation
       * capability takes. Read it back with `get_conversation`.
       */
      conversationPublicId: conversationPublicIdSchema,
      userMessageId: z.string().uuid(),
      assistantMessageId: z.string().uuid(),
      /** `arun_…`: the run this turn was recorded as; `get_run` opens it. */
      runId: z.string().regex(/^arun_[0-9a-z]+$/),
      /** The assistant's reply, whole. */
      reply: z.string(),
      /**
       * Every governed write this turn parked, in the order they parked;
       * empty when nothing did. A turn can park more than one — each is a real
       * approval row with its own five-minute expiry — so surfacing one and
       * dropping the rest would leave a person answering for a write they were
       * never shown, while the others expire unseen.
       */
      parkedCards: z.array(assistantParkedCardSchema),
      /**
       * True when the person who asked stopped the turn with
       * `cancel_assistant_turn`. `reply` then holds what the engine wrote
       * before the stop, possibly nothing, and the run is sealed `cancelled`.
       */
      stopped: z.boolean().default(false),
    })
    .strict(),
});

export type AssistantAskInput = z.output<typeof assistantAsk.input>;
export type AssistantAskOutput = z.output<typeof assistantAsk.output>;
export type AssistantPageContext = z.output<typeof assistantPageContextSchema>;
export type AssistantParkedCard = z.output<typeof assistantParkedCardSchema>;
export type AssistantGoal = z.output<typeof assistantGoalSchema>;
