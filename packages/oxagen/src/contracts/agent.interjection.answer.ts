// answer_interjection: a person answers the question an agent paused to ask
// (#3839). The handler records the answer on the `agent.interjections` row
// and, for a wrapped run whose host can take it, queues the answer as a
// `message` command so the run reads it on its next step.
//
// An answer is a person's decision, so the contract is not on the `agent`
// surface (ADR-175), the same as `resolve_approval`. It is not a governed
// action either: ADR-055's 2026-09-15 ratification makes `resolve_approval`
// the only billable one, so this declares `noBillingGate: true` (INV-28).
//
// Two refusals leave the handler as `HandlerError { code: "conflict" }`:
// `reason: "interjection_answered"` when someone answered first, and
// `reason: "interjection_expired"` when the run stopped waiting. An id that
// matches no row in scope also answers `interjection_expired`, as
// `resolve_approval` does, so the answer never tells a caller whether an id
// exists in another workspace.
import { z } from "zod";
import { registerCapability } from "../registry";

const PUBLIC_ID = /^inj_[0-9a-z]+$/i;
const ROW_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An interjection id: the public id (`inj_…`) or the row uuid. */
export const interjectionIdSchema = z
  .string()
  .refine(
    (value) => PUBLIC_ID.test(value) || ROW_UUID.test(value),
    "interjectionId must be a public id (inj_…) or a uuid",
  );

export function isInterjectionPublicId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

/** The longest answer a person can send, in characters. */
export const INTERJECTION_ANSWER_MAX = 4000;

export const agentInterjectionAnswer = registerCapability({
  name: "answer_interjection",
  domain: "agent",
  description:
    "Answer the question an agent paused to ask. The answer is recorded on the question, and a wrapped run whose host can take it receives the answer as a message.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      interjectionId: interjectionIdSchema,
      answer: z.string().trim().min(1).max(INTERJECTION_ANSWER_MAX),
    })
    .strict(),
  output: z
    .object({
      /** The public id (`inj_…`) of the question answered. */
      interjectionId: z.string(),
      /** The public id of the run that asked (`arun_…` or `tse_…`). */
      runId: z.string(),
      answeredAt: z.string().datetime({ offset: true }),
      /**
       * The `tcm_…` id of the queued `message` command that carries the
       * answer to the run. Empty for a ledger run, and when no host can take
       * it: the answer then lives on the question and in the audit record.
       */
      commandIds: z.array(z.string()),
    })
    .strict(),
});

export type AgentInterjectionAnswerInput = z.output<
  typeof agentInterjectionAnswer.input
>;
export type AgentInterjectionAnswerOutput = z.output<
  typeof agentInterjectionAnswer.output
>;
