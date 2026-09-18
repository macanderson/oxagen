/**
 * render.ts — turning one decision into whatever a harness understands.
 *
 * A renderer may reword and reshape. It may not decide. Every function here
 * takes a finished {@link GateDecision} and returns bytes, so a new harness
 * costs one function and can never disagree with the others about whether a
 * checkout is stale.
 *
 * Copy follows the Oxagen voice: actor first, present tense, what happened
 * and then what to do. No em dashes and no semicolons in anything a person
 * reads, which is why the strings below are built from short sentences.
 */
import type { GateDecision } from "./gate";
import type { FreshnessVerdict } from "./check";
import type { PathChange } from "./git";

/**
 * The renderers, and the harness names that map onto them.
 *
 * `user-prompt-submit` is one renderer for two products on purpose. Claude
 * Code and Codex CLI both fire a `UserPromptSubmit` hook that reads a JSON
 * object from the hook's stdout, and their contracts overlap almost exactly:
 *
 *   - Claude Code blocks on
 *     `hookSpecificOutput.permissionDecision = "deny"` with
 *     `permissionDecisionReason`, and adds context with
 *     `hookSpecificOutput.additionalContext` (plus `systemMessage` for a line
 *     the developer sees).
 *   - Codex blocks on top-level `decision = "block"` with `reason`, and adds
 *     context with the same `hookSpecificOutput.additionalContext`.
 *   - Both treat exit code 2 with a message on stderr as a refusal.
 *
 * The blocking payload carries all three signals at once. Each harness reads
 * the keys it knows and ignores the rest, they cannot disagree because they
 * are rendered from one decision, and exit 2 catches any harness that reads
 * neither. That is what makes a new agent an entry in the alias table rather
 * than a new code path.
 */
export const RENDERER_NAMES = ["text", "user-prompt-submit", "json"] as const;
export type RendererName = (typeof RENDERER_NAMES)[number];

/** Harness name to renderer. Unknown names fall back to `text`. */
export const HARNESS_RENDERERS: Record<string, RendererName> = {
  text: "text",
  json: "json",
  "user-prompt-submit": "user-prompt-submit",
  "claude-code": "user-prompt-submit",
  codex: "user-prompt-submit",
};

/** Harness names an installer or a `--harness` flag accepts. */
export const HARNESSES = Object.keys(HARNESS_RENDERERS).sort();

/** Where a renderer's bytes belong, and what the process should exit with. */
export interface RenderedGate {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function label(change: PathChange): string {
  switch (change.status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "changed";
  }
}

/** The file list, indented, at most `limit` lines. */
function fileList(changes: readonly PathChange[], limit = 10): string[] {
  const shown = changes.slice(0, limit).map((c) => {
    return `  ${label(c).padEnd(8)} ${c.path}`;
  });
  if (changes.length > limit) {
    shown.push(`  ${String(changes.length - limit)} more`);
  }
  return shown;
}

function recordCount(n: number): string {
  return n === 1 ? "1 record" : `${n} records`;
}

function target(verdict: FreshnessVerdict): string {
  return verdict.branch
    ? `${verdict.remote}/${verdict.branch}`
    : verdict.remote;
}

/** Where the blocking or auto-sync switch was set, for the explaining line. */
function scopeName(scope: string | null): string {
  switch (scope) {
    case "workspace":
      return "your Oxagen workspace";
    case "project":
      return ".oxagen/settings.json";
    case "local":
      return ".oxagen/settings.local.json";
    case "user":
      return "your user settings";
    default:
      return "your settings";
  }
}

/**
 * The transcript banner: the same words whatever agent is reading them.
 *
 * Returns an empty string when there is nothing worth a developer's
 * attention. A gate that speaks on every clean prompt is a gate people learn
 * to scroll past, and then it is not a gate.
 */
export function renderBanner(decision: GateDecision): string {
  const { action, verdict, policy, sync } = decision;
  const lines: string[] = [];

  if (action === "allow") {
    // The one clean case worth a line: auto-sync just changed files under
    // the developer's feet, and silence there would be worse than noise.
    if (sync?.applied) {
      lines.push(
        `Oxagen synced .oxagen/ from ${target(verdict)}. ${sync.message}`,
      );
      return lines.join("\n");
    }
    return "";
  }

  const headline =
    action === "block"
      ? `Run stopped. Steering in this checkout is ${recordCount(
          verdict.missing.length,
        )} behind ${target(verdict)}.`
      : `Steering in this checkout is ${recordCount(
          verdict.missing.length,
        )} behind ${target(verdict)}.`;
  lines.push(headline);
  lines.push("");
  lines.push(...fileList(verdict.missing));
  lines.push("");

  if (sync && !sync.applied && sync.refusal) {
    lines.push(`Auto-sync did not run. ${sync.message}`);
    lines.push("");
  }

  if (verdict.status === "diverged") {
    lines.push(
      "This branch also changed .oxagen/, so the two have to be reconciled by hand.",
    );
    lines.push("");
  }

  if (action === "block") {
    lines.push(
      verdict.status === "diverged"
        ? "Reconcile .oxagen/ with the production branch, then run the prompt again."
        : "Run `oxagen steering sync`, then run the prompt again.",
    );
    lines.push(
      `Blocking is set in ${scopeName(policy.sources.blockStaleRuns)}. Set OXAGEN_STEERING_FRESHNESS=off for this shell to override it.`,
    );
  } else {
    lines.push(
      "Run `oxagen steering sync` to take them. The agent is running on the older records until you do.",
    );
  }

  for (const note of verdict.notes) lines.push(note);
  return lines.join("\n").trimEnd();
}

/** The default renderer: a banner on stderr, and an exit code. */
export function renderText(decision: GateDecision): RenderedGate {
  const banner = renderBanner(decision);
  return {
    stdout: "",
    stderr: banner ? `${banner}\n` : "",
    exitCode: decision.exitCode,
  };
}

/**
 * The `UserPromptSubmit` hook contract shared by Claude Code and Codex CLI.
 *
 * `additionalContext` is the field that matters most: it folds the banner
 * into the turn the model sees, which is what puts the warning *in the
 * transcript* rather than only in a terminal the developer may have
 * scrolled away from. An agent that can read "the records in this checkout
 * are older than the ones in force" can also say so, and stop relying on
 * them.
 *
 * Pinned by `render.test.ts` against the literal field names. A typo here
 * degrades silently in the worst possible direction: both harnesses ignore
 * keys they do not recognise, so a misspelled `permissionDecisionReason` is
 * a gate that runs, decides correctly, and lets the prompt through without
 * a word.
 */
export function renderUserPromptSubmit(decision: GateDecision): RenderedGate {
  const banner = renderBanner(decision);
  if (decision.action === "block") {
    return {
      stdout: `${JSON.stringify({
        // Codex CLI.
        decision: "block",
        reason: banner,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          // Claude Code.
          permissionDecision: "deny",
          permissionDecisionReason: banner,
        },
      })}\n`,
      // Exit 2 with the reason on stderr is the refusal any harness
      // understands, including one that reads neither JSON shape.
      stderr: `${banner}\n`,
      exitCode: 2,
    };
  }
  if (!banner) return { stdout: "", stderr: "", exitCode: 0 };
  return {
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: banner,
        // Claude Code only. Puts the same words in front of the developer,
        // not just the model.
        systemMessage: banner,
      },
    })}\n`,
    stderr: "",
    exitCode: 0,
  };
}

/** The whole decision, for a harness that wants to render it itself. */
export function renderJson(decision: GateDecision): RenderedGate {
  return {
    stdout: `${JSON.stringify(
      {
        action: decision.action,
        status: decision.verdict.status,
        remote: decision.verdict.remote,
        branch: decision.verdict.branch,
        behindByRecords: decision.verdict.missing.length,
        behindByCommits: decision.verdict.behindByCommits,
        missing: decision.verdict.missing,
        localChanges: decision.verdict.local,
        dirty: decision.verdict.dirty,
        fingerprint: decision.verdict.fingerprint,
        fetch: decision.verdict.fetch,
        notes: decision.verdict.notes,
        platform: decision.verdict.platform,
        policy: {
          autoSync: decision.policy.autoSync,
          blockStaleRuns: decision.policy.blockStaleRuns,
          suspended: decision.policy.suspended,
          suspendedReason: decision.policy.suspendedReason,
          sources: decision.policy.sources,
        },
        sync: decision.sync,
        banner: renderBanner(decision),
      },
      null,
      0,
    )}\n`,
    stderr: "",
    exitCode: decision.exitCode,
  };
}

const RENDERERS: Record<RendererName, (d: GateDecision) => RenderedGate> = {
  text: renderText,
  "user-prompt-submit": renderUserPromptSubmit,
  json: renderJson,
};

/**
 * Render for one harness.
 *
 * An unrecognised name falls back to `text` rather than failing. A harness
 * this build has never heard of is one whose adapter will be added later,
 * and the exit-code contract is the one every shell already understands, so
 * it is the right thing to degrade to.
 */
export function renderGate(
  decision: GateDecision,
  harness: string,
): RenderedGate {
  const name = HARNESS_RENDERERS[harness] ?? "text";
  return RENDERERS[name](decision);
}
