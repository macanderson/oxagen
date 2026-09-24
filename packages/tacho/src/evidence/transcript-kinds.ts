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
