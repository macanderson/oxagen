/**
 * What a session's tool calls did that the git lane reads beside git: the
 * Bash calls that ran `git commit`, and the paths its write tools wrote.
 * The git lane names the call that made each commit from the first, and
 * flags a commit holding a path the session never wrote from the second
 * (`session_commits`, ADR-297).
 *
 * Both live in memory only, keyed by the session's record, the way
 * `recallDirs` in the hook handler is, so the daemon's state file never
 * holds them. A restarted daemon has seen none of the session's earlier
 * calls, so it starts with no calls and no record of written paths, and
 * the fields they feed are left out rather than guessed.
 */
import type { CommitCall } from "./session-commits";

/** The most commit calls one session keeps, the oldest dropped first. */
export const MAX_COMMIT_CALLS = 64;

/**
 * The most written paths one session keeps. Past it, the record is no
 * longer complete, and the git lane stops flagging commits from it.
 */
export const MAX_WRITTEN_PATHS = 4_096;

interface Activity {
  calls: CommitCall[];
  written: Set<string>;
  /** False when a path may be missing: past the bound, or seen mid-session. */
  complete: boolean;
}

const activity = new WeakMap<object, Activity>();

/**
 * The record of one session's activity, made on the first hook this daemon
 * sees for it. Only a session this daemon saw start has a complete record
 * of the paths it wrote.
 */
function activityOf(session: object, started: boolean): Activity {
  let found = activity.get(session);
  if (found === undefined) {
    found = { calls: [], written: new Set(), complete: started };
    activity.set(session, found);
  }
  return found;
}

/** One tool hook, as the hook handler reads it. */
export interface ToolActivity {
  hookEvent: string;
  /** The session was created by this hook, a `SessionStart`. */
  started: boolean;
  toolUseId?: string;
  /** When the hook was received, in epoch ms. */
  at: number;
  /** Set for a Bash call whose line runs `git commit`. */
  commits?: boolean;
  /** The absolute path a write tool named. */
  writtenPath?: string;
}

/** Note one hook's activity for the git lane. */
export function noteToolActivity(session: object, hook: ToolActivity): void {
  const found = activityOf(session, hook.started);
  if (hook.toolUseId === undefined) return;
  if (hook.hookEvent === "PreToolUse" && hook.commits === true) {
    found.calls.push({ toolUseId: hook.toolUseId, from: hook.at });
    found.calls.splice(0, Math.max(0, found.calls.length - MAX_COMMIT_CALLS));
    return;
  }
  if (
    hook.hookEvent !== "PostToolUse" &&
    hook.hookEvent !== "PostToolUseFailure"
  )
    return;
  const call = found.calls.find((c) => c.toolUseId === hook.toolUseId);
  if (call !== undefined && call.to === undefined) call.to = hook.at;
  // Only a write that ran counts. Claude Code sends `PostToolUse` for a
  // call that succeeded and `PostToolUseFailure` for one that failed.
  if (
    hook.hookEvent === "PostToolUse" &&
    hook.writtenPath !== undefined &&
    !found.written.has(hook.writtenPath)
  ) {
    if (found.written.size >= MAX_WRITTEN_PATHS) found.complete = false;
    else found.written.add(hook.writtenPath);
  }
}

/** What the git lane reads for one session's reconciliation. */
export function sessionActivity(session: object): {
  calls: readonly CommitCall[];
  written?: ReadonlySet<string>;
} {
  const found = activity.get(session);
  if (found === undefined) return { calls: [] };
  return {
    calls: found.calls,
    ...(found.complete ? { written: found.written } : {}),
  };
}
