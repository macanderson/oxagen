/**
 * The chip vocabulary a run's transcript filters on (the run page mockup's
 * transcript chips, `mockups/pages/run.md`; spec §14).
 *
 * It lives here, in the leaf package, for the same reason `REPLAY_GRADES`
 * does: the capability contract publishes it as a closed enum and the
 * projection over frames derives it, and those two live in packages that do
 * not depend on each other. One list, read by both, is what keeps a chip the
 * interface offers and a chip the server understands the same set.
 *
 * The order is the mockup's, so a filter's URL lists its chips the way the
 * page draws them. `policy` is not a mockup chip; the Policy tab reads it.
 */

export const TRANSCRIPT_KINDS = [
  /**
   * What went out to a model: the request half of a model call, or the
   * prompt an operator typed to open a turn of a wrapped run.
   */
  "prompt",
  /** What came back from a model: the response half, or a single receipt. */
  "responses",
  /**
   * A model call that spent reasoning tokens (`thinking_tokens`). The text of
   * the reasoning shows where the recorder kept the stream; the count shows
   * wherever the provider reported it.
   */
  "thinking",
  /** Either half of a tool call. */
  "tools",
  /** A decision a rule or a person made about a call: allow, deny, route. */
  "policy",
  /** A frame that carried a cost record. */
  "usage",
  /** What was pulled into the model's context. */
  "recall",
  /**
   * The chain's own integrity record: a wrapped session's signed
   * `checkpoint` and its `telemetry_gap`, or the ledger event that closes an
   * attempt before its seal.
   */
  "seal",
  /** A call that did not do what it was asked to. */
  "errors",
] as const;

export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export function isTranscriptKind(value: unknown): value is TranscriptKind {
  return (
    typeof value === "string" &&
    (TRANSCRIPT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * What kind of row a folded transcript entry is (ADR-182). The server's fold
 * states it on each entry so a reader draws the entry without reading its
 * frames again.
 *
 * - `prompt`: the operator's words, a `turn_start` on the run's own chain;
 * - `reply`: a message the agent reported, `turn_end` or `oxagen:message`;
 * - `model` and `tool`: a model call and a tool call;
 * - `policy`: a decision a rule or a person made, or an operator's command;
 * - `recall`: what was put in front of the model;
 * - `seal`: the run's own stop;
 * - `control`: a frame that frames the run rather than records what it did;
 * - `event`: any other frame.
 */
export const TRANSCRIPT_NODES = [
  "prompt",
  "reply",
  "model",
  "tool",
  "policy",
  "recall",
  "seal",
  "control",
  "event",
] as const;

export type TranscriptNode = (typeof TRANSCRIPT_NODES)[number];

/**
 * How a folded entry's call ended: it did what it was asked (`ok`), it
 * failed, a rule or the harness refused it (`denied`), it waits on an
 * approval (`parked`), or nothing has come back yet (`pending`).
 */
export const TRANSCRIPT_OUTCOMES = [
  "ok",
  "failed",
  "denied",
  "parked",
  "pending",
] as const;

export type TranscriptOutcome = (typeof TRANSCRIPT_OUTCOMES)[number];

/**
 * The family a tool belongs to, read from its name: whether a call
 * inspected, changed, ran or delegated something. The names are listed here
 * so the contract and the fold read one list; which name falls in which
 * family is `@oxagen/run-ledger`'s `toolFamilyOf`.
 */
export const TOOL_FAMILIES = [
  "shell",
  "read",
  "edit",
  "create",
  "delete",
  "search",
  "web",
  "skill",
  "agent",
  "plan",
  "notebook",
  "mcp",
  "tool",
] as const;

export type ToolFamily = (typeof TOOL_FAMILIES)[number];
