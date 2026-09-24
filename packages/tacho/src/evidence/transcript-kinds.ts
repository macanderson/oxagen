/**
 * The chip vocabulary a run's transcript filters on (Mission Control mockup
 * `TX_GROUPS`; spec §14).
 *
 * It lives here, in the leaf package, for the same reason `REPLAY_GRADES`
 * does: the capability contract publishes it as a closed enum and the
 * projection over frames derives it, and those two live in packages that do
 * not depend on each other. One list, read by both, is what keeps a chip the
 * interface offers and a chip the server understands the same set.
 *
 * The mockup also draws a `thinking` chip. Neither the ledger's event
 * vocabulary nor a wrapped session's kinds records a reasoning segment in this
 * revision, so there is no kind for it: a chip that can only ever answer
 * "none" would be the placeholder §3.4 forbids. It arrives with the frame type
 * that records reasoning content, not before.
 */

export const TRANSCRIPT_KINDS = [
  /**
   * What went out to a model: the request half of a model call, or the
   * prompt an operator typed to open a turn of a wrapped run.
   */
  "prompt",
  /** What came back from a model: the response half, or a single receipt. */
  "responses",
  /** Either half of a tool call. */
  "tools",
  /** A decision a rule or a person made about a call: allow, deny, route. */
  "policy",
  /** What was pulled into the model's context. */
  "recall",
  /** A frame that carried a cost record. */
  "usage",
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
