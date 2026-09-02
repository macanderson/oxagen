// Sandbox session work-recovery (spec: docs/specs/sandbox-session-lifecycle §6).
//
// Before a warm sandbox is flushed, its uncommitted work MUST be captured. This
// routine runs ENTIRELY INSIDE the sandbox over the existing exec primitive, so
// it needs no GitHub token resolver, no GitHub-API client, and no cross-package
// dependency (which would create an inngest-functions → handlers cycle):
//
//   - The sandbox already holds fresh push credentials. `ModalSandboxWorkspace`
//     is reconstructed every turn and rewrites $HOME/.git-credentials with a
//     freshly-resolved token on each bootstrap. The reaper fires only 2-3 min
//     after the LAST turn, so that token is comfortably inside its ~1 h validity.
//   - So recovery is just: detect a dirty working tree, commit it, and
//     `git push origin HEAD:refs/heads/recovery/<label>/<utc-ts>`.
//   - Repo-backed-ness is detected dynamically (`git remote get-url origin`);
//     a raw/non-repo sandbox has nothing to recover and is safe to flush.
//
// The routine is PURE: it execs and returns an outcome. All DB state transitions
// (recovery_status, recovery_branch, flushed_at, …) are applied by the caller
// (the reaper or the `recover_sandbox_session` capability), which centralizes the
// invariant "a dirty sandbox is only flushed AFTER its work is safe".
import { agentSandboxExecHandler } from "./agent.sandbox.exec";
import { SandboxSessionGoneError } from "./_sandbox-session";
import type { CapabilityContext } from "../types";

/** Time budget for the in-sandbox recovery script (git add/commit/push). */
const RECOVERY_TIMEOUT_MS = 120_000;

export type RecoveryKind =
  /** No uncommitted changes — safe to flush. */
  | "clean"
  /** Not a git working tree (raw/eval sandbox) — nothing to recover, safe to flush. */
  | "no-repo"
  /** Uncommitted work was pushed to a recovery branch — safe to flush. */
  | "recovered"
  /** Dirty work could NOT be saved (no remote / commit / push failed) — RETAIN. */
  | "failed"
  /** The sandbox was reaped out from under us — dead, work lost — flush the row. */
  | "gone";

export interface RecoveryOutcome {
  kind: RecoveryKind;
  /** Whether an uncommitted-changes state was observed (null = unknown/not a repo). */
  dirty: boolean | null;
  /** Recovery branch, when kind === "recovered". */
  branch?: string;
  /** Recovery commit sha, when kind === "recovered". */
  commit?: string;
  /** Failure detail, when kind === "failed" | "gone". */
  error?: string;
}

/** Derive a filesystem-safe, human-recognizable branch label from the session id. */
export function recoveryLabel(publicId: string): string {
  const cleaned = publicId
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (cleaned || "session").slice(0, 24);
}

// The recovery script. Emits single-line OXA_* markers on stdout that we parse
// below. Written defensively (no `set -e`) so a failure at any step yields a
// marker rather than an opaque non-zero exit with no signal. Uses UNBRACED
// shell vars ($OXA_LABEL, $BRANCH, $COMMIT) so no `${…}` is interpolated by JS
// at module load — the branch label arrives via the OXA_LABEL env var.
const RECOVERY_SCRIPT = `
cd /work 2>/dev/null || { echo OXA_NO_WORKDIR; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo OXA_NO_GIT; exit 0; }
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
git add -A >/dev/null 2>&1 || true
if git diff --cached --quiet >/dev/null 2>&1; then echo OXA_CLEAN; exit 0; fi
echo OXA_DIRTY
if [ -z "$ORIGIN" ]; then echo OXA_NO_ORIGIN; exit 0; fi
BRANCH="recovery/$OXA_LABEL/$(date -u +%Y%m%dT%H%M%SZ)"
if ! git -c user.email=recovery@oxagen.sh -c user.name="Oxagen Recovery" \\
     commit -m "chore(recovery): auto-saved uncommitted work from sandbox $OXA_LABEL" \\
     --no-verify >/dev/null 2>&1; then
  echo OXA_COMMIT_FAIL; exit 0
fi
COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
if git push origin "HEAD:refs/heads/$BRANCH" --no-verify >/dev/null 2>/tmp/oxa_push_err; then
  echo "OXA_BRANCH=$BRANCH"
  echo "OXA_COMMIT=$COMMIT"
  echo OXA_PUSHED
else
  echo OXA_PUSH_FAIL
  head -c 400 /tmp/oxa_push_err 2>/dev/null || true
fi
`;

/**
 * Detect and capture uncommitted work in a durable sandbox session. Must be
 * called inside the session's tenant scope (the exec handler reads the ambient
 * AsyncLocalStorage tenant). Returns an outcome; performs NO DB writes.
 */
export async function recoverSandboxSession(
  ctx: CapabilityContext,
  opts: { sessionId: string },
): Promise<RecoveryOutcome> {
  const label = recoveryLabel(opts.sessionId);

  let stdout: string;
  try {
    const res = await agentSandboxExecHandler(
      {
        sessionId: opts.sessionId,
        command: RECOVERY_SCRIPT,
        timeoutMs: RECOVERY_TIMEOUT_MS,
        env: { OXA_LABEL: label },
      },
      ctx,
    );
    if (res.timedOut) {
      return {
        kind: "failed",
        dirty: null,
        error: "recovery command timed out",
      };
    }
    stdout = res.stdout ?? "";
  } catch (err) {
    // The sandbox was reaped before we could recover — its filesystem is gone.
    if (err instanceof SandboxSessionGoneError) {
      return {
        kind: "gone",
        dirty: null,
        error: "sandbox gone before recovery",
      };
    }
    return {
      kind: "failed",
      dirty: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const lines = stdout.split("\n").map((l) => l.trim());
  const has = (m: string) => lines.includes(m);
  const valueOf = (prefix: string): string | undefined =>
    lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);

  if (has("OXA_NO_WORKDIR") || has("OXA_NO_GIT")) {
    return { kind: "no-repo", dirty: false };
  }
  if (has("OXA_CLEAN")) {
    return { kind: "clean", dirty: false };
  }
  // From here the tree is dirty.
  if (has("OXA_PUSHED")) {
    return {
      kind: "recovered",
      dirty: true,
      branch: valueOf("OXA_BRANCH="),
      commit: valueOf("OXA_COMMIT="),
    };
  }
  if (has("OXA_NO_ORIGIN")) {
    return {
      kind: "failed",
      dirty: true,
      error: "no git remote to push recovery branch to",
    };
  }
  if (has("OXA_COMMIT_FAIL")) {
    return {
      kind: "failed",
      dirty: true,
      error: "git commit of uncommitted work failed",
    };
  }
  if (has("OXA_PUSH_FAIL")) {
    const detail = stdout
      .slice(stdout.indexOf("OXA_PUSH_FAIL") + "OXA_PUSH_FAIL".length)
      .trim();
    return {
      kind: "failed",
      dirty: true,
      error: `git push failed${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    };
  }
  // Dirty but no terminal marker — be conservative and RETAIN.
  return {
    kind: "failed",
    dirty: true,
    error: "recovery produced no conclusive result",
  };
}
