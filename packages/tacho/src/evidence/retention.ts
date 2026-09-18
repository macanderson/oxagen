/**
 * Which frames a mandate authorises keeping exact bytes for.
 *
 * `retention` has two parts and both bind. `mode` says whether exact bytes may
 * be kept at all, and `classes` says which content the workspace authorised,
 * from the same vocabulary the run ledger uses
 * (`RETENTION_CONTENT_CLASSES` in `@oxagen/run-ledger`). A host that read the
 * mode alone would keep a prompt for a workspace that authorised tool results
 * and nothing else, which is the opposite of what the operator asked for.
 *
 * The vocabulary is mirrored here rather than imported: `@oxagen/tacho` takes
 * no `@oxagen/*` runtime dependency (ADR-078 section 4). `retention.test.ts`
 * is where the two are held in step, and the ingest handler applies this same
 * function on the way in, so a body is never kept at one end and refused at
 * the other.
 *
 * A kind this table does not name keeps nothing. New frames arrive faster
 * than mandates are rewritten, so an unmapped kind failing open would retain
 * content no operator authorised, which is the failure that matters here.
 */

/** The content class each frame kind's body belongs to. */
export const RETENTION_CLASS_BY_KIND: Readonly<Record<string, string>> = {
  // What was asked and what came back: the content of the model exchange.
  turn_start: "model_call",
  turn_end: "model_call",
  llm_call: "model_call",
  "oxagen:message": "model_call",
  subagent_stop: "model_call",
  // What a tool was handed and what it returned.
  tool_call: "tool_call",
};

export interface RetentionMandate {
  mode: "digest_only" | "content_exact";
  classes: readonly string[];
}

/**
 * Whether this frame's body may be kept, on disk or in the control plane.
 *
 * Both callers, the host deciding what to write and the control plane
 * deciding what to accept, answer the same question with this function, so a
 * body can never be kept at one end and refused at the other.
 */
export function retainsBody(
  kind: string,
  retention: RetentionMandate | undefined,
): boolean {
  if (retention === undefined) return false;
  if (retention.mode !== "content_exact") return false;
  const contentClass = RETENTION_CLASS_BY_KIND[kind];
  if (contentClass === undefined) return false;
  return retention.classes.includes(contentClass);
}
