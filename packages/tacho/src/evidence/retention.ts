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
 *
 * This table is the only one. `contentClassOf` in `frame-body.ts`, which the
 * host asks when it decides whether to write a body at all, reads it too.
 * They were two tables until one fell behind, and the shape of that failure
 * is why they are now one: the host classified `tool_requested`,
 * `token_denied` and `approval_request`, wrote their bodies and shipped
 * them, and the control plane refused all three as
 * `retention_class_excluded` because this table named none of them. A
 * workspace paying for `content_exact` on tool calls lost every tool request
 * body and recorded a `body_missing` gap for it, and a denied approval lost
 * the only exact record of what was asked for. Nothing failed loudly,
 * because refusing a body is an ordinary answer.
 */

/** The content classes a mandate can authorise. */
export type RetentionContentClass =
  | "model_call"
  | "tool_call"
  | "approval_receipt";

/** The content class each frame kind's body belongs to. */
export const RETENTION_CLASS_BY_KIND: Readonly<
  Record<string, RetentionContentClass>
> = {
  // What was asked and what came back: the content of the model exchange.
  turn_start: "model_call",
  turn_end: "model_call",
  llm_call: "model_call",
  "oxagen:message": "model_call",
  subagent_stop: "model_call",
  // What a tool was handed and what it returned. `tool_requested` carries
  // the arguments as the agent proposed them, which is the only record of
  // what it meant to do when the call is then denied, and `token_denied`
  // carries the call the gateway refused.
  tool_requested: "tool_call",
  tool_call: "tool_call",
  "oxagen:worktree_reconciled": "tool_call",
  token_denied: "tool_call",
  // What a person was asked to approve.
  approval_request: "approval_receipt",
};

/**
 * Every class a body on this host can belong to: the values of the table
 * above, deduplicated, and not a second list beside it. A caller comparing
 * two mandates to find what narrowed needs the set of classes to compare,
 * and a hand-written copy of that set is the failure this table already has
 * a paragraph about.
 */
export const HOST_RETENTION_CLASSES: readonly RetentionContentClass[] =
  Object.freeze([
    ...new Set(Object.values(RETENTION_CLASS_BY_KIND)),
  ]) as readonly RetentionContentClass[];

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

/**
 * The mandate to read when there is no trustworthy one: keep nothing.
 *
 * A cached bundle is a file on the operator's machine. It authorises
 * retention only while its signature verifies, so a host holding one that
 * does not falls back to this rather than to what the file happens to say.
 */
export const NO_RETENTION: RetentionMandate = {
  mode: "digest_only",
  classes: [],
};

/**
 * The mandate that keeps only what both of these keep.
 *
 * A host that accepted a narrowing and has not finished erasing under it holds
 * that clause on disk until the sweep succeeds. If a second verified bundle
 * arrives first, the host owes both erasures, and one clause that owes both is
 * the intersection: `content_exact` only where both say so, and only the
 * classes both name. Taking the newer clause alone would drop the older debt,
 * and a bundle that narrows one class while widening another would then leave
 * the first class's bytes on disk with nothing left that names them.
 *
 * Intersecting only ever erases more, never less, which is the direction a
 * retention mandate is allowed to err in.
 */
export function narrowestOf(
  a: RetentionMandate,
  b: RetentionMandate,
): RetentionMandate {
  return {
    mode:
      a.mode === "content_exact" && b.mode === "content_exact"
        ? "content_exact"
        : "digest_only",
    classes: a.classes.filter((contentClass) =>
      b.classes.includes(contentClass),
    ),
  };
}
