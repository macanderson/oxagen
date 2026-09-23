/**
 * Whether the workspace's model policy permits the model a request asks for.
 *
 * The rule is small on purpose. `@oxagen/tacho` is a leaf package with no
 * `@oxagen/*` runtime dependency, so it has no glob library, and a policy a
 * person writes into a settings field has to behave the way they expect from
 * reading it. So: an exact id, or an id ending in `*` that matches by prefix.
 * Case is ignored, because a model id is a vendor's lowercase string and a
 * policy that failed on a capitalised paste would be a trap.
 *
 * Deny beats allow. An operator who lists a model in both has said the second
 * thing more recently than they said the first, and the refusing reading is
 * the one that cannot leak spend.
 */

/** Whether `model` matches one pattern: exact, or a trailing `*` by prefix. */
function modelMatches(pattern: string, model: string): boolean {
  const left = pattern.toLowerCase();
  const right = model.toLowerCase();
  return left.endsWith("*")
    ? right.startsWith(left.slice(0, -1))
    : right === left;
}

export interface ModelPolicy {
  /** `null` = no allowlist, every model passes; `[]` = permit nothing. */
  allow: string[] | null;
  deny: string[];
}

/** Why a model was refused, or `undefined` when the policy permits it. */
export type ModelVerdict = "denied" | "not_allowed" | undefined;

/**
 * The policy's verdict on one model.
 *
 * Missing models return no verdict here. The proxy separately refuses an
 * unreadable model on metered endpoints when a model policy is armed.
 */
export function modelVerdict(
  policy: ModelPolicy | undefined,
  model: string | undefined,
): ModelVerdict {
  if (policy === undefined || model === undefined) return undefined;
  if (policy.deny.some((pattern) => modelMatches(pattern, model)))
    return "denied";
  if (policy.allow === null) return undefined;
  return policy.allow.some((pattern) => modelMatches(pattern, model))
    ? undefined
    : "not_allowed";
}
