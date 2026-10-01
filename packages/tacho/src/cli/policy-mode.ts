/**
 * The Policy line: what the host's policy mode does, in one sentence per
 * mode. `oxagen agent status` prints it on its Policy line and `oxagen agent enroll` ends
 * with it. The desktop app's This machine panel prints the same sentences
 * from its own copy (`policyText` in apps/desktop/src/tacho-status.ts),
 * because the app shares no runtime code with the CLI. This file's test and
 * the app's `tacho-status.test.ts` each read the other copy and fail when the
 * two differ.
 *
 * The mode decides the whole evaluation of a governed tool call
 * (`evaluatePreToolUse` in packages/tacho/src/host/bundle.ts), not only the
 * permission rules. Under `enforce`, a mandate that requires the contained
 * tier denies every tool in a session `oxagen agent run --contained` did not start.
 * A stale bundle denies a call that can change something while the control
 * plane is unreachable. A deny rule or a Cedar forbid denies, an ask rule
 * asks, and a call no rule covers goes to the harness's own permission flow.
 * Under `observe`, each of those decisions is recorded and the call goes
 * ahead.
 *
 * Three things refuse in both modes, which is why neither sentence says
 * nothing is enforced. Operator controls deny: a suspended, paused or revoked
 * host, and a paused or cancelled session. A bundle that does not verify is
 * treated as absent, so a call that can change something is denied whatever
 * mode it claims. The model proxy refuses a model the mandate does not permit
 * and a call past an enforced budget, on model calls routed through it
 * (`refusalFor` in packages/tacho/src/collector/model-proxy.ts).
 */

/** The sentence for each mode the bundle schema names (`tachoBundleModeSchema`). */
export const POLICY_MODE_TEXT = {
  observe:
    "observe: Oxagen records what the policy would decide on a governed call and lets it go ahead. Budget and model limits still apply to model calls routed through Oxagen.",
  enforce:
    "enforce: the policy can deny a governed call or ask first. Budget and model limits also apply to model calls routed through Oxagen.",
} as const;

/** The most characters of an unrecognized mode the line repeats. */
const RAW_MODE_MAX = 64;

/**
 * The Policy line for `mode`, checked by name. The value is taken unvalidated
 * on purpose: a caller that reads host.json without the bundle schema (the
 * desktop app does) can hold a missing mode, a hand-edited one, or one a
 * newer CLI added. Each of those names itself instead of reading as
 * `observe`, which is what the desktop panel used to show for any value that
 * was not `enforce`.
 */
export function policyModeText(mode: unknown): string {
  if (mode === "observe") return POLICY_MODE_TEXT.observe;
  if (mode === "enforce") return POLICY_MODE_TEXT.enforce;
  return `unknown policy mode: ${rawMode(mode)}`;
}

/**
 * An unrecognized mode as the line prints it. A plain word prints as itself,
 * anything else as JSON, so an empty string, a space or a number reads as
 * what it is. A long value is cut, because it came from a file someone
 * edited and the line has one row.
 */
function rawMode(mode: unknown): string {
  if (mode === undefined || mode === null) return "not set";
  const text =
    typeof mode === "string" && /^[!-~]+$/.test(mode)
      ? mode
      : (JSON.stringify(mode) ?? String(mode));
  return text.length > RAW_MODE_MAX
    ? `${text.slice(0, RAW_MODE_MAX)}...`
    : text;
}
