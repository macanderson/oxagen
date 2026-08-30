/**
 * dispatch-mode.ts — the pure routing policy for the REPL's Dispatch mode
 * (docs/specs/repl-async-dispatch.md §2, §3.1).
 *
 * Dispatch mode turns the composer into an always-parallel dispatcher: a plain
 * prompt is handed to a detached background worker so the composer frees
 * immediately, while explicit markers keep individual prompts inline. This
 * module is the single decision point — a pure function over the prompt text
 * and the mode flag, with NO React, NO process spawn, NO store — so the exact
 * routing matrix is unit-testable without a TTY (dispatch-mode.test.ts pins
 * the whole truth table).
 *
 * Routing is fully deterministic — there is no intent heuristic. Mode ON
 * dispatches every plain prompt, and the user keeps inline control via the
 * explicit `=`/`>` prefix. An LLM triager remains a possible v2.
 *
 * The decision leans on one primitive that already exists:
 *   - `parseAmpersandDispatch` (sessions/dispatch.ts): the shell-familiar
 *     trailing-` &` background suffix, which already refuses slash/shell
 *     commands and bare "&".
 *
 * Precedence (first match wins):
 *   1. trailing ` &`            → background (BOTH modes; the explicit primitive)
 *   2. mode OFF                 → inline (today's behavior, text untouched)
 *   3. slash `/` or shell `!`   → inline (commands never dispatch)
 *   4. forced-inline `=`/`>`    → inline, marker stripped ("do this one now")
 *   5. mode ON                  → background (everything else)
 */
import { parseAmpersandDispatch } from "../sessions/dispatch.js";

/**
 * The routing outcome. `prompt` is the text to act on with any routing markers
 * (` &` suffix, `=`/`>` prefix) already stripped — callers pass it straight to
 * the dispatcher or the inline turn without re-parsing.
 */
export type DispatchDecision =
  | { kind: "inline"; prompt: string }
  | { kind: "background"; prompt: string };

export interface DecideDispatchOptions {
  /** Whether Dispatch mode is currently ON. */
  mode: boolean;
}

/**
 * A leading `=` or `>` (optionally followed by one space) forces a prompt to
 * run inline even in Dispatch mode — "do this one right here, I'll wait". Pure
 * prefix check, no config. Only consulted when the mode is ON (when it is OFF
 * everything runs inline anyway, so a literal `=`/`>` prompt is left intact).
 */
const FORCE_INLINE_PREFIX = /^\s*[=>]\s?/;

/**
 * Decide whether `text` runs inline (today's turn) or dispatches to a detached
 * background worker. See the module header for the full precedence table.
 */
export function decideDispatch(
  text: string,
  opts: DecideDispatchOptions,
): DispatchDecision {
  // 1. Explicit trailing ` &` always backgrounds, in either mode. This already
  //    strips the marker and refuses slash/shell commands and bare "&".
  const ampersand = parseAmpersandDispatch(text);
  if (ampersand !== null) return { kind: "background", prompt: ampersand };

  // 2. Mode OFF: never auto-dispatch. Leave the text exactly as typed.
  if (!opts.mode) return { kind: "inline", prompt: text };

  // 3. Slash / shell commands never dispatch — they are handled by the REPL's
  //    own dispatcher / shell runner, not the model.
  const lead = text.trimStart();
  if (lead.startsWith("/") || lead.startsWith("!")) {
    return { kind: "inline", prompt: text };
  }

  // 4. Forced-inline escape hatch: strip the `=`/`>` marker and run inline.
  const forced = FORCE_INLINE_PREFIX.exec(text);
  if (forced) return { kind: "inline", prompt: text.slice(forced[0].length) };

  // 5. Mode ON: everything else dispatches to a background worker.
  return { kind: "background", prompt: text.trim() };
}
