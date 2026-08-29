/**
 * Presentational components for the REPL.
 *
 * Kept deliberately free of heavy imports (no agent loop, no context engine) so
 * they render instantly and are unit-testable in isolation with
 * ink-testing-library.
 */
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import React, { useState, useEffect, useRef } from "react";
import { theme } from "../tui/theme.js";
import { Markdown } from "../tui/markdown.js";
import { formatUsd } from "../agent/model-router.js";
import {
  getToolEmoji,
  getToolAccent,
  toolDisplayLabel,
  isSubagentDispatch,
} from "../agent/tool-formatter.js";
import { DiffView } from "./diff-view.js";
import { TerminalRunCard, type TerminalRun } from "./terminal-panel.js";
import type { DiffTheme } from "../tui/terminal-theme.js";
import { SlashMenu } from "./slash-menu.js";
import {
  BUILTIN_SLASH_COMMANDS,
  slashQuery,
  filterSlashCatalog,
  type SlashCatalogEntry,
} from "../slash/catalog.js";
import type {
  StageEvent,
  StageKind,
  TurnTrace,
  JudgeVerdict,
  ScopeReviewInfo,
} from "../agent/trace.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionMode,
} from "../agent/permissions.js";
import { readClipboardImage as readClipboardImageDefault } from "../lib/clipboard-image.js";
import {
  createPasteRegistry,
  resetPasteRegistry,
  shouldCollapseText,
  registerPastedText,
  registerPastedImage,
  tokenEndingAt,
  tokenStartingAt,
  dropTokenAt,
  expandPasteSubmission,
  type PasteSubmission,
  type PastedImageAttachment,
} from "./paste.js";
import { useMouseSelect } from "./use-mouse-select.js";
import { isStrayMouseReportRemnant } from "./alt-screen.js";
import {
  selectionRange,
  hasSelection,
  pressAt,
  dragTo,
  deleteSelectionFrom,
  replaceSelectionWith,
  textStartColumn,
  charOffsetForColumn,
  type Selection,
} from "./mouse-select.js";

export interface Message {
  role:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool"
    | "stage"
    | "diff"
    | "terminal"
    | "scope";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
  /** Present on `role: "stage"` messages — a live pipeline progress event. */
  stage?: StageEvent;
  /**
   * Present on `role: "scope"` messages — the pre-execution scope-review
   * snapshot (original + enhanced prompt, routed model, estimated cost). Always
   * surfaced so the user sees how their prompt was enhanced and what the work is
   * estimated to cost; rendered truncated unless the transcript is in verbose
   * (Ctrl-O) mode. See {@link ScopeCard}.
   */
  scope?: ScopeReviewInfo;
  /** Present on `role: "diff"` messages — the unified git diff to render. */
  diff?: string;
  /** Present on `role: "diff"` messages — the relative paths the diff touches. */
  changedFiles?: string[];
  /** When present, the message renders the full replay view for a turn. */
  trace?: TurnTrace;
  /** When present, the message renders the end-of-turn summary card. */
  summary?: TurnSummary;
  /**
   * Present on `role: "terminal"` messages — a FINISHED `!command` folded inline
   * into the transcript as a collapsed, expandable accordion once its live red
   * panel has timed out. See {@link TerminalRunCard}.
   */
  terminalRun?: TerminalRun;
  /** Whether the terminal accordion is expanded (Ctrl-O toggles the latest). */
  terminalExpanded?: boolean;
}

/**
 * Headline outcome of a turn, rendered as a boxed card once the work settles.
 * Only fields the pipeline actually produces are populated — completeness +
 * confidence from the advisor judge, the files the agent touched, and the
 * priced cost. Test/PR/CI status is intentionally absent (the REPL turn does
 * not run those) rather than shown as fabricated data.
 */
export interface TurnSummary {
  /** Whether the advisor judged the work complete (or the turn simply finished). */
  complete: boolean;
  /** Advisor confidence 0–100 → shown as the "quality" score. Absent in bare mode. */
  quality?: number;
  /**
   * Why the advisor scored the turn the way it did — its reasoning, or the
   * concrete gaps it found. Shown under the score so a number never appears
   * without its justification. Absent in bare mode.
   */
  qualityReason?: string;
  /** Relative paths the agent wrote or edited. */
  filesTouched: string[];
  /** Priced cost of the turn, USD. */
  costUsd: number;
  /** True when the pipeline ran (judged); false for the bare agent. */
  judged: boolean;
  /** Present on `role: "diff"` — the unified git diff to render (highlighted). */
  diff?: string;
  /** Present on `role: "diff"` — the changed-file paths, for the header line. */
  changedFiles?: string[];
}

/**
 * One `/name [hint]  description` line per built-in command, generated from
 * {@link BUILTIN_SLASH_COMMANDS} — the same catalog the menu and typeahead
 * read from — so `/help` can never drift out of sync with what `/` actually
 * lists.
 */
function formatBuiltinCommandLines(): string[] {
  const invocations = BUILTIN_SLASH_COMMANDS.map(
    (c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
  );
  const width = Math.max(...invocations.map((s) => s.length));
  return BUILTIN_SLASH_COMMANDS.map(
    (c, i) => `  ${(invocations[i] as string).padEnd(width)}  ${c.description}`,
  );
}

export const HELP = [
  "Slash commands (type / to browse them with descriptions):",
  ...formatBuiltinCommandLines(),
  "  ←/→, Home/End  move the cursor to edit the prompt bar mid-line",
  "  Ctrl-J         insert a newline (multiline prompt) instead of submitting",
  "  !<command>     run a shell command live — the bar turns into a red terminal,",
  "                 output streams into a pinned panel, and it runs immediately",
  "                 (even mid-turn). Esc/Ctrl-C kills the running command. When it",
  "                 finishes the red panel folds into the chat as a collapsed card.",
  "  Ctrl-O         expand/collapse the most recent folded !command output",
  "  Ctrl-V twice   open the most recently touched file in $VISUAL/$EDITOR",
  "  Ctrl-T         inspect the planner's task list for this turn (also /tasks)",
  "  Ctrl-S         watch the agent swarm — every live agent + status (also /swarm)",
  "  Ctrl-X twice   kill the newest running agent (in the swarm panel: the selected one)",
  "Dispatch mode — /dispatch [on|off|cap <n>|status] (docs/specs/repl-async-dispatch.md):",
  "  prompt &       trailing ` &` always dispatches to a detached background worker —",
  "                 the bar frees immediately and the completion folds back into the",
  "                 transcript as an attributed one-liner (works in either mode)",
  "  =prompt        with the mode ON, a leading `=` (or `> `) forces that one prompt",
  "                 to run inline; every other plain prompt goes to the background,",
  "                 capped at `/dispatch cap <n>` concurrent workers (excess queues)",
  "Type / to open the command menu — 📦 marks built-in & CLI commands; every",
  "`oxagen --help` command is browsable there too (custom commands show no glyph).",
  "Permission prompt: y allow once · a allow + remember · n/Esc deny",
  "  Esc            stop the turn · press Esc twice to reset the conversation (confirm y/yes)",
  "  Ctrl-C         cancel the current turn (quits when idle)",
  "Side-panel navigation (Agent Team + Task Progress dock):",
  "  ↑ (on the bar) recall every queued prompt back into the bar to edit",
  "  ↓ / ↑          move focus into the dock and walk the agent/task rows (Esc = back to bar)",
  "  Ctrl-E         open the highlighted agent's log · or edit the highlighted task's title",
  "  Ctrl-X twice   delete the highlighted agent or task",
].join("\n");

/** Friendly label for a permission mode (matches the `/mode` argument spelling). */
export function modeLabel(mode: PermissionMode): string {
  return mode === "acceptEdits"
    ? "auto-edit"
    : mode === "readonly"
      ? "read-only"
      : mode;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compact token count: 980 → "980", 1234 → "1.2k", 23000 → "23k", 87.1e6 → "87.1M". */
export function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// ── Prompt Input ──────────────────────────────────────────────────────────────

/** Window (ms) a second Ctrl-V must land within to open the editor. */
export const CTRL_V_EDITOR_WINDOW_MS = 1500;

/**
 * The pure double-press decision for Ctrl-V (same shape as files-panel's
 * resolveCtrlO and ctrl-c-action's resolveCtrlC): the first press arms, a
 * second within the window fires the open-in-editor gesture.
 */
export function resolveCtrlV(
  lastCtrlVMs: number | null,
  now: number,
): "arm" | "open" {
  if (lastCtrlVMs !== null && now - lastCtrlVMs <= CTRL_V_EDITOR_WINDOW_MS) {
    return "open";
  }
  return "arm";
}

export function PromptInput({
  onSubmit,
  busy,
  borderColor,
  mouseRow,
  mouseEnabled = false,
  catalog = [],
  focused = true,
  inject,
  onMenuOpenChange,
  onEmptyChange,
  onOpenLastTouched,
  readClipboardImage = readClipboardImageDefault,
}: {
  /**
   * Fires on Enter. `text` is exactly what the bar showed (paste placeholders
   * left compact, e.g. `[Text #1]`) — for the transcript/HUD. `paste` is
   * present only when the buffer held at least one placeholder token: its
   * `expandedText` has every `[Text #N]` inlined to full content (for the
   * model instruction) and `images` lists the `[Image #N]` attachments, in
   * order. Omitted (no paste occurred) is the common case.
   */
  onSubmit: (text: string, paste?: PasteSubmission) => void;
  /** A turn is in flight. The input stays live — submissions queue (Claude
   *  Code-style) instead of being blocked — but the glyph shows the busy state. */
  busy: boolean;
  /**
   * Turn-lifecycle border color, animated by the caller (see
   * repl/border-phase.ts + interactive.tsx's flash-tick effect): cyan while
   * idle, a rapid rainbow flash while the coordinator evaluates the prompt,
   * solid amber once the turn is actively working. Optional so standalone/
   * test usage keeps today's plain `busy ? amber : cyan` behavior — `focused`
   * (dim) and terminal/shell mode (red) are the input's OWN local state and
   * still take precedence over this when set.
   */
  borderColor?: string;
  /**
   * 1-based terminal row the input's content line currently renders at (see
   * mouse-select.ts's `inputContentRow`) — lets a click/drag be mapped to a
   * character offset. `undefined` disables mouse text-selection entirely
   * (classic/non-fullscreen mode, or off a real TTY) while keyboard editing
   * stays fully unaffected either way.
   */
  mouseRow?: number;
  /**
   * Whether SGR mouse tracking is currently armed (mirrors the same
   * `fullscreen && mouseOn` condition interactive.tsx already gates
   * useMouseWheel with). Click/drag is a no-op while false — the existing
   * `/mouse` toggle disables this the same way it disables wheel scroll.
   */
  mouseEnabled?: boolean;
  /** Slash-command catalog powering the live typeahead menu (empty = no menu). */
  catalog?: ReadonlyArray<SlashCatalogEntry>;
  /**
   * Whether the input owns the keyboard. When false the parent has moved focus
   * into the side panel (arrow-key navigation), so the input ignores every
   * keystroke and hides its block cursor — the panel handler owns arrows,
   * Ctrl-E, and Ctrl-X until focus returns here. Defaults true (standalone use).
   */
  focused?: boolean;
  /**
   * External buffer injection. When `nonce` changes the buffer is replaced with
   * `text` — used to recall queued prompts for editing (Up), load a task's
   * title for editing (Ctrl-E on a task), and clear the bar as focus moves
   * between agents. The menu is suppressed for injected text so a recalled
   * slash string doesn't reopen the typeahead unbidden.
   */
  inject?: { text: string; nonce: number };
  /** Notifies the parent when the typeahead menu opens/closes so it knows
   *  whether the arrow keys belong to menu navigation or panel navigation. */
  onMenuOpenChange?: (open: boolean) => void;
  /**
   * Notifies the parent whenever the buffer transitions empty↔non-empty.
   * The full-screen transcript viewport uses this to gate Up/Down/Home/End
   * between "scroll the transcript" (buffer empty) and their normal meaning
   * — recall the queue, enter the side panel, move the cursor (buffer has
   * text) — see interactive.tsx's `inputEmptyRef`.
   */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Double-Ctrl-V gesture: fires when a second Ctrl-V lands within
   * {@link CTRL_V_EDITOR_WINDOW_MS} of the first. The parent opens the most
   * recently touched file in $VISUAL/$EDITOR (see interactive.tsx). The FIRST
   * press still fire-and-forgets the image-paste probe below — with no image
   * on the clipboard (the common case) that inserts nothing, so the gesture
   * is clean; with one, a single pasted token may remain (backspace removes
   * it). Undefined disables the gesture (standalone/test usage).
   */
  onOpenLastTouched?: () => void;
  /**
   * Reads a system-clipboard image to a temp PNG (Ctrl-V). Injectable for
   * tests; defaults to the real macOS pngpaste/osascript implementation.
   * Resolves `null` (never throws) when there's no image to attach.
   */
  readClipboardImage?: () => Promise<PastedImageAttachment | null>;
}): React.ReactElement {
  const [value, setValue] = useState("");
  // Flat character offset into `value` (0..value.length). Left/Right/Home/End
  // move it; typing, backspace, and delete all act relative to it instead of
  // always at the end — so a prompt can be edited in the middle, not just
  // appended to.
  const [cursorPos, setCursorPos] = useState(0);
  // Mouse-drag text selection (Claude-Code-style): null = no selection (a
  // plain cursor, the common case). `cursorPos` above doubles as the
  // selection's visible caret while one is active — see mouse-select.ts's
  // anchor/head model. Backspace/Delete/typing consume it; Left/Right/Home/
  // End collapse it back to a plain cursor, same as any text editor.
  const [selection, setSelection] = useState<Selection | null>(null);
  // Highlighted suggestion + whether the user dismissed the menu (Esc). Both
  // reset to their defaults whenever the buffer changes via typing.
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const { stdout } = useStdout();
  // Paste placeholder registry (`[Text #N]` / `[Image #N]` → real content).
  // Same lifecycle as `value`: lives for one prompt, reset in `resetInput`.
  const pasteRegistryRef = useRef(createPasteRegistry());
  // Timestamp of the last Ctrl-V press — the double-press editor gesture.
  const lastCtrlVRef = useRef<number | null>(null);

  // Replace the buffer when the parent injects new text (queue recall, task
  // edit, or a clear). Keyed on the nonce so the same text can be re-injected
  // (e.g. clearing to "" twice in a row). `dismissed` is set so injected text
  // never pops the typeahead; typing afterwards clears it as usual.
  // Deps intentionally list only `injectNonce`: the effect must fire once per
  // distinct injection, reading the latest text at that instant — not re-run
  // when the text alone changes.
  const injectNonce = inject?.nonce;
  const injectedText = inject?.text ?? "";
  useEffect(() => {
    if (injectNonce === undefined) return;
    setValue(injectedText);
    setCursorPos(injectedText.length);
    setSelected(0);
    setDismissed(true);
    // An injected buffer is a wholesale replacement, not an edit — any of this
    // prompt's paste tokens the injected text still shows (e.g. a recalled
    // queued prompt) are now inert history, not live registry entries. Reset
    // so the NEXT paste numbers from 1 instead of colliding with a stale or
    // already-submitted token of the same name.
    resetPasteRegistry(pasteRegistryRef.current);
  }, [injectNonce]);

  // Derive the live typeahead state from the current buffer. The menu is open
  // only while the buffer is a single `/word` token and the user hasn't
  // dismissed it.
  const query = dismissed ? null : slashQuery(value);
  const suggestions = query === null ? [] : filterSlashCatalog(catalog, query);
  const menuOpen = suggestions.length > 0;
  // Surface menu open/close to the parent so it can route arrow keys: while the
  // menu is open the arrows navigate suggestions; while it's closed they belong
  // to the parent (Up = recall queue, Down = enter the side panel).
  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
  }, [menuOpen, onMenuOpenChange]);
  const isEmpty = value.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  // `selected` may lag the (shrinking) suggestion list; clamp for rendering/use.
  const sel =
    suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  const cols = stdout?.columns ?? 80;
  const menuWidth = Math.min(Math.max(cols - 2, 40), 100);

  const resetInput = (): void => {
    setValue("");
    setCursorPos(0);
    setSelection(null);
    setSelected(0);
    setDismissed(false);
    // Fresh counters for the next prompt — token numbering restarts at 1.
    resetPasteRegistry(pasteRegistryRef.current);
  };

  /** Splice `text` in at the cursor and advance the cursor past it — the one
   *  path every insert (typed chars, a paste, an explicit newline) goes
   *  through, so the cursor never drifts out of sync with the buffer. An
   *  active selection is replaced wholesale instead (typing/pasting over a
   *  selection replaces it — the same rule every text editor follows), which
   *  covers typed characters, a text paste, and an image-paste token alike
   *  since they all funnel through here. */
  const insertAtCursor = (text: string): void => {
    if (hasSelection(selection)) {
      const { text: nextValue, cursorPos: nextCursor } = replaceSelectionWith(
        value,
        selection,
        text,
      );
      setValue(nextValue);
      setCursorPos(nextCursor);
      setSelection(null);
      setSelected(0);
      setDismissed(false);
      return;
    }
    setValue((v) => v.slice(0, cursorPos) + text + v.slice(cursorPos));
    setCursorPos((p) => p + text.length);
    setSelected(0);
    setDismissed(false);
  };

  useInput((input, key) => {
    // When focus has moved into the side panel the input owns no keys: the
    // parent's panel handler drives arrows / Ctrl-E / Ctrl-X. Ignoring here
    // (rather than in the parent) keeps a single, race-free owner per keystroke.
    if (!focused) return;
    // Ink has no built-in concept of SGR mouse reports (wheel or the click/
    // drag/release reports useMouseSelect above also listens for) — it falls
    // through EVERY one of them to a bare `input` string with every `key.*`
    // flag false, which would otherwise hit the generic insert-text branch
    // at the bottom of this handler and type garbage into the buffer on
    // every mouse wheel tick / click / drag. See alt-screen.ts's
    // isStrayMouseReportRemnant for why this can't be fixed upstream.
    if (isStrayMouseReportRemnant(input)) return;

    // Mouse tracking (SGR modes 1000 + 1006, armed for wheel scroll in the
    // full-screen TUI) makes the terminal report every click/drag/scroll to
    // stdin as an SGR escape sequence: `(ESC)[<Cb;Cx;Cy(M|m)`. Ink hands those to
    // useInput as raw `input`; they are NOT typed text, so without this guard a
    // click, drag, or scroll sprays escape codes straight into the prompt (the
    // "input fills with garbage on mouse" bug). Drop them here; the wheel itself
    // is consumed by the raw-stdin listener in use-mouse-wheel.ts. (Mode 1006 is
    // always on, so the legacy X10 form never occurs — SGR is sufficient.)
    const mouseSeq = input.charCodeAt(0) === 0x1b ? input.slice(1) : input;
    if (/^\[?<[0-9;]+[Mm]$/.test(mouseSeq)) return;

    // Any key other than Ctrl-V breaks the double-Ctrl-V editor chain (the
    // same disarm-on-other-key rule the files panel applies to Ctrl-O).
    if (!(key.ctrl && input === "v")) lastCtrlVRef.current = null;

    // ── Typeahead navigation (only while the menu is open) ──
    if (menuOpen) {
      if (key.downArrow) {
        setSelected(
          (s) => (Math.min(s, suggestions.length - 1) + 1) % suggestions.length,
        );
        return;
      }
      if (key.upArrow) {
        setSelected(
          (s) =>
            (Math.min(s, suggestions.length - 1) - 1 + suggestions.length) %
            suggestions.length,
        );
        return;
      }
      if (key.tab) {
        const pick = suggestions[sel];
        if (pick) {
          // Complete to `/name `; commands taking args keep the trailing space
          // (and a closed menu) so the user types arguments next.
          const completed = `/${pick.name}${pick.argumentHint ? " " : ""}`;
          setValue(completed);
          setCursorPos(completed.length);
          setSelected(0);
          setDismissed(false);
        }
        return;
      }
      if (key.escape) {
        setDismissed(true);
        return;
      }
      if (key.return && !key.shift) {
        const pick = suggestions[sel];
        if (pick) {
          const exact = value.trim() === `/${pick.name}`;
          if (exact || !pick.argumentHint) {
            // Fully-typed, or an argument-free command: run it now.
            onSubmit(`/${pick.name}`);
            resetInput();
          } else {
            // Selected a different/partial command that takes args: complete it
            // and keep editing rather than firing the wrong command.
            const completed = `/${pick.name} `;
            setValue(completed);
            setCursorPos(completed.length);
            setSelected(0);
            setDismissed(false);
          }
        }
        return;
      }
    }

    // ── Plain line editing ──
    if (key.tab) return; // never insert a literal tab character
    if (key.return && !key.shift) {
      const trimmed = value.trim();
      if (trimmed) {
        // Expand paste placeholders for the model NOW, while the registry
        // still holds this prompt's entries — resetInput() below wipes them.
        const paste = expandPasteSubmission(pasteRegistryRef.current, trimmed);
        const hadTokens =
          paste.images.length > 0 || paste.expandedText !== trimmed;
        onSubmit(trimmed, hadTokens ? paste : undefined);
        resetInput();
      }
      return;
    }
    // Ctrl-V: bracketed paste (below, via usePaste) already handles TEXT —
    // this is the ONLY signal available for an IMAGE paste, since a terminal
    // sends nothing at all to stdin when Cmd-V's clipboard has no text
    // representation. Async: the clipboard check shells out, so this fires
    // and forgets rather than blocking the keystroke. A SECOND Ctrl-V within
    // the window is the open-in-editor gesture (see onOpenLastTouched).
    if (key.ctrl && input === "v") {
      const now = Date.now();
      if (
        onOpenLastTouched &&
        resolveCtrlV(lastCtrlVRef.current, now) === "open"
      ) {
        lastCtrlVRef.current = null;
        onOpenLastTouched();
        return;
      }
      lastCtrlVRef.current = now;
      void (async (): Promise<void> => {
        const image = await readClipboardImage();
        if (!image) return; // no image on the clipboard, or no tool available
        const token = registerPastedImage(pasteRegistryRef.current, image);
        insertAtCursor(token);
      })();
      return;
    }
    // Cursor movement — active whenever the menu isn't consuming the key
    // (i.e. always, since the menuOpen block above never claims arrows).
    // Left/Right on an active selection COLLAPSE to that edge (standard
    // editor convention: the first arrow press after a selection lands the
    // cursor at its start/end, it doesn't ALSO step one further) rather than
    // moving relative to wherever the drag happened to leave `cursorPos`.
    // Home/End are absolute moves regardless of a selection, so no such
    // edge-collapse applies to them — just clear it same as any other move.
    if (key.leftArrow) {
      if (hasSelection(selection)) {
        setCursorPos(selectionRange(selection).start);
        setSelection(null);
      } else {
        setCursorPos((p) => Math.max(0, p - 1));
      }
      return;
    }
    if (key.rightArrow) {
      if (hasSelection(selection)) {
        setCursorPos(selectionRange(selection).end);
        setSelection(null);
      } else {
        setCursorPos((p) => Math.min(value.length, p + 1));
      }
      return;
    }
    if (key.home) {
      setSelection(null);
      setCursorPos(0);
      return;
    }
    if (key.end) {
      setSelection(null);
      setCursorPos(value.length);
      return;
    }
    // Explicit newline — Ctrl-J sends a bare linefeed on every terminal,
    // unlike Shift+Enter, whose byte sequence is terminal-dependent and often
    // indistinguishable from plain Enter. Named explicitly rather than left as
    // an accidental fall-through of the generic insert branch below (which
    // would also happen to catch it, since it's non-ctrl/non-meta input).
    if (input === "\n") {
      insertAtCursor("\n");
      return;
    }
    if (key.backspace) {
      // An active selection is a bulk delete target — Backspace removes the
      // WHOLE selected range in one keystroke, same as Delete below, rather
      // than falling through to the single-char/token logic.
      if (hasSelection(selection)) {
        const { text: nextValue, cursorPos: nextCursor } = deleteSelectionFrom(
          value,
          selection,
        );
        setValue(nextValue);
        setCursorPos(nextCursor);
        setSelection(null);
        setSelected(0);
        setDismissed(false);
        return;
      }
      if (cursorPos > 0) {
        // A paste placeholder is an atomic unit: backspacing right after one
        // deletes the WHOLE token (and its registry entry) in one keystroke,
        // instead of eroding it character by character.
        const span = tokenEndingAt(pasteRegistryRef.current, value, cursorPos);
        const deleteFrom = span ? span.start : cursorPos - 1;
        if (span) dropTokenAt(pasteRegistryRef.current, value, span);
        setValue((v) => v.slice(0, deleteFrom) + v.slice(cursorPos));
        setCursorPos(deleteFrom);
        setSelected(0);
        setDismissed(false);
      }
      return;
    }
    if (key.delete) {
      // Same bulk-delete-the-selection rule as Backspace above.
      if (hasSelection(selection)) {
        const { text: nextValue, cursorPos: nextCursor } = deleteSelectionFrom(
          value,
          selection,
        );
        setValue(nextValue);
        setCursorPos(nextCursor);
        setSelection(null);
        setSelected(0);
        setDismissed(false);
        return;
      }
      // Symmetric with backspace: forward-delete removes a whole token when
      // the cursor sits at its start.
      const span = tokenStartingAt(pasteRegistryRef.current, value, cursorPos);
      const deleteTo = span ? span.end : cursorPos + 1;
      if (span) dropTokenAt(pasteRegistryRef.current, value, span);
      setValue((v) => v.slice(0, cursorPos) + v.slice(deleteTo));
      setSelected(0);
      setDismissed(false);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      insertAtCursor(input);
    }
  });

  // Bracketed-paste TEXT arrives here as one string, on its own channel —
  // ink auto-enables bracketed paste mode and never forwards paste content to
  // `useInput` once a `usePaste` listener is registered, so this and the
  // keystroke handler above never race over the same paste. Bracketed paste is
  // ALSO why pasted text is never garbled: the whole clipboard payload lands
  // here as one clean string instead of being re-parsed keystroke-by-keystroke.
  // A single-line paste inserts inline in full; a multi-line one collapses to a
  // `[first 12…N Lines…last 12]` preview chip (see paste.ts) so the bar shows a
  // compact, recognizable reference instead of a wall of text.
  usePaste((text) => {
    if (!focused) return;
    const token = shouldCollapseText(text)
      ? registerPastedText(pasteRegistryRef.current, text)
      : null;
    insertAtCursor(token ?? text);
  });

  // Terminal-emulator mode: the instant the buffer opens with "!", the prompt
  // bar turns into a shell — red border, a `$` prompt — signalling that Enter
  // runs the rest as a live command (immediately, even mid-turn) rather than
  // sending it to the agent. See the `!command` handler in interactive.tsx.
  const terminalMode = focused && value.startsWith("!");
  // `focused`/`terminalMode` are the input's OWN local state — they win over
  // the caller's turn-lifecycle animation (dim, and shell-red, both need to
  // read unambiguously regardless of what the turn is doing). Falls back to
  // the pre-animation `busy ? amber : cyan` when the caller doesn't drive
  // `borderColor` at all (standalone/test usage).
  const accent = !focused
    ? theme.dim
    : terminalMode
      ? TERMINAL_RED
      : (borderColor ?? (busy ? theme.amber : theme.cyan));
  const glyph = terminalMode ? "$ " : busy ? "⧗ " : "❯ ";
  // In terminal mode the visible command drops the leading "!" — the `$` prompt
  // already conveys "this is a shell", so echoing the bang too is redundant.
  const shown = terminalMode ? value.replace(/^!/, "") : value;
  // cursorPos is an offset into `value`; shift it left by one in terminal mode
  // to stay valid against `shown`, which is one character shorter (the
  // stripped leading "!"). The mouse handlers below apply the SAME shift in
  // the opposite direction when mapping a click back into `value`.
  const shownCursor = Math.max(0, cursorPos - (terminalMode ? 1 : 0));
  const terminalShift = terminalMode ? 1 : 0;

  // Screen column the buffer's first character renders at — see
  // mouse-select.ts's textStartColumn. Single-line mapping only (see that
  // module's doc comment for the wrapped/multi-line degrade).
  const textStartCol = textStartColumn(glyph.length);
  /** A clicked/dragged screen column -> a clamped offset into `value`. */
  const offsetForColumn = (col: number): number => {
    const shownOffset = charOffsetForColumn(col, textStartCol, shown.length);
    return Math.max(0, Math.min(value.length, shownOffset + terminalShift));
  };
  useMouseSelect(
    {
      onPress: (col) => {
        const offset = offsetForColumn(col);
        setCursorPos(offset);
        setSelection(pressAt(offset));
      },
      onDrag: (col) => {
        const offset = offsetForColumn(col);
        setCursorPos(offset);
        setSelection((sel) => (sel ? dragTo(sel, offset) : pressAt(offset)));
      },
      onRelease: () => {
        // A press with no drag collapses to a zero-width selection — clear it
        // outright so it renders/acts as a plain cursor, not a degenerate
        // "selection" of nothing.
        setSelection((sel) => (sel && hasSelection(sel) ? sel : null));
      },
    },
    mouseRow,
    mouseEnabled,
  );

  const beforeCursor = shown.slice(0, shownCursor);
  // The character the cursor sits on (highlighted in place); empty when the
  // cursor is at the end of the buffer — the common case, and the only one
  // the pre-cursor-tracking bar ever had, so it keeps the same solid block.
  const atCursor = shown.slice(shownCursor, shownCursor + 1);
  const afterCursor = shown.slice(shownCursor + 1);
  // Selection highlight range, in `shown`-relative offsets (same terminal-
  // mode shift as shownCursor above) — computed only when a real (non-
  // zero-width) selection exists; the cursor-block rendering above stays the
  // fallback otherwise, unchanged from before mouse selection existed.
  const activeSelection = hasSelection(selection) ? selection : null;
  const selRange = activeSelection ? selectionRange(activeSelection) : null;
  const beforeSelection = selRange
    ? shown.slice(0, Math.max(0, selRange.start - terminalShift))
    : "";
  const selectedText = selRange
    ? shown.slice(
        Math.max(0, selRange.start - terminalShift),
        Math.max(0, selRange.end - terminalShift),
      )
    : "";
  const afterSelection = selRange
    ? shown.slice(Math.max(0, selRange.end - terminalShift))
    : "";

  return (
    <Box flexDirection="column">
      {menuOpen && (
        <SlashMenu
          entries={suggestions}
          selectedIndex={sel}
          width={menuWidth}
        />
      )}
      {/* The bordered input keeps a constant height (one text row inside a round
          border = 3 rows). minHeight + flexShrink={0} guarantee it never
          collapses or is squeezed as the conversation above grows — though a
          multi-line buffer (Ctrl-J) grows it further, unconstrained. */}
      <Box
        borderStyle="round"
        borderColor={accent}
        paddingX={1}
        minHeight={3}
        flexShrink={0}
      >
        <Text color={accent} bold>
          {glyph}
        </Text>
        <Text dimColor={!focused}>
          {activeSelection ? (
            // A drag-made selection (Claude-Code-style): render the dragged
            // range inverse, same visual language as the single-char cursor
            // block below — no separate caret glyph inside it, matching how
            // a highlighted range reads in any text editor.
            <>
              {beforeSelection}
              <Text inverse>{selectedText}</Text>
              {afterSelection}
            </>
          ) : (
            <>
              {beforeCursor}
              {/* The cursor shows only while the input holds focus; when the panel
                  has focus the bar dims and drops it so the highlight clearly
                  lives in the side panel instead. Mid-string it inverts the
                  character it sits on; at the end of the buffer (the common case)
                  there's no character to invert, so it falls back to the same
                  solid block the bar always drew. In terminal mode it takes the
                  shell-red accent so the whole bar reads as a live terminal. */}
              {focused ? (
                atCursor ? (
                  <Text inverse>{atCursor}</Text>
                ) : (
                  <Text color={accent}>█</Text>
                )
              ) : (
                atCursor
              )}
              {afterCursor}
            </>
          )}
        </Text>
      </Box>
      {terminalMode && (
        <Box paddingX={1}>
          <Text color={TERMINAL_RED} dimColor>
            terminal · Enter runs · Esc/Ctrl-C kills
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Terminal red — shared with the TerminalPanel outline (repl/terminal-panel.tsx). */
const TERMINAL_RED = "#F87171";

// ── Permission approval prompt ─────────────────────────────────────────────────

/**
 * Shown in place of the input row while the agent is blocked waiting for the
 * human to approve a mutating tool call. Captures a single keystroke:
 * `y` allow once · `a` allow and remember (auto-allow identical calls this
 * session) · `n` / Esc deny. The pending promise is resolved by the container.
 */
export function ApprovalPrompt({
  req,
  onResolve,
}: {
  req: ApprovalRequest;
  onResolve: (response: ApprovalResponse) => void;
}): React.ReactElement {
  useInput((input, key) => {
    const ch = (input || "").toLowerCase();
    if (ch === "y") onResolve({ decision: "allow" });
    else if (ch === "a") onResolve({ decision: "allow", remember: true });
    else if (ch === "n" || key.escape) onResolve({ decision: "deny" });
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#FBBF24"
      paddingX={1}
    >
      <Box>
        <Text color="#FBBF24" bold>
          {"⚠ permission · "}
        </Text>
        <Text dimColor>{req.reason}</Text>
      </Box>
      <Box>
        <Text wrap="truncate-end">{req.summary}</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text>
          <Text color="#34D399" bold>
            y
          </Text>
          <Text dimColor> allow once</Text>
        </Text>
        <Text>
          <Text color={theme.cyan} bold>
            a
          </Text>
          <Text dimColor> allow + remember</Text>
        </Text>
        <Text>
          <Text color="#FB7185" bold>
            n
          </Text>
          <Text dimColor> deny (Esc)</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── Message Display ───────────────────────────────────────────────────────────

// ── Pipeline stage badge ────────────────────────────────────────────────────

// Exported (not module-private) so a test can assert these Record<StageKind, ...>
// maps stay exhaustive as the canonical StageKind union (from @oxagen/agent-engine,
// re-exported via ../agent/trace.js) evolves — see stage-kind-exhaustive.test.tsx.
export const STAGE_GLYPH: Record<StageKind, string> = {
  evaluate: "◇",
  plan: "☰",
  enhance: "◆",
  route: "⊚",
  execute: "▸",
  judge: "⚖",
  revise: "↻",
  complete: "✓",
};

export const STAGE_COLOR: Record<StageKind, string> = {
  evaluate: "#A78BFA",
  plan: "#A78BFA",
  enhance: "#A78BFA",
  route: theme.cyan,
  execute: "#FBBF24",
  judge: "#34D399",
  revise: "#FB7185",
  complete: "#34D399",
};

/**
 * A compact line announcing one pipeline stage as it happens. Rendered in the
 * same bracketed-chip grammar as tool calls, but with the stage's own dim glyph
 * so pipeline chatter stays visually subordinate to the concrete actions the
 * agent takes.
 */
export function StageBadge({
  stage,
}: {
  stage: StageEvent;
}): React.ReactElement {
  const color = STAGE_COLOR[stage.kind];
  return (
    <Box paddingX={1}>
      <Text color={color}>{STAGE_GLYPH[stage.kind]} </Text>
      <Text color={color} dimColor>
        [{STAGE_LABEL[stage.kind]}]
      </Text>
      <Text>{"  "}</Text>
      <Text dimColor wrap="truncate-end">
        {stage.label}
      </Text>
      {stage.detail ? <Text dimColor> · {stage.detail}</Text> : null}
    </Box>
  );
}

/** Title-cased chip label for each pipeline stage. */
export const STAGE_LABEL: Record<StageKind, string> = {
  evaluate: "Evaluate",
  plan: "Plan",
  enhance: "Enhance",
  route: "Route",
  execute: "Execute",
  judge: "Review",
  revise: "Revise",
  complete: "Complete",
};

// ── Action chips ────────────────────────────────────────────────────────────

/**
 * One tool call, rendered as `[📖 Read]  src/foo.ts`. The bracket is tinted
 * by what the tool does (see getToolAccent) so writes/deletes/commands/reads are
 * distinguishable at a glance; the argument trails, truncated to one line.
 * Tools without a mapped emoji render as a bare `[name]` chip — no filler glyph.
 */
function ToolChip({ msg }: { msg: Message }): React.ReactElement {
  const name = msg.toolName ?? "tool";
  const subagent = isSubagentDispatch(name);
  // Subagent delegation gets its own grammar (`[🚀 Task]  slug → what`) and a
  // violet accent; every other tool keeps a use-colored chip.
  const accent = subagent ? "#A78BFA" : getToolAccent(name);
  const emoji = getToolEmoji(name);
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color={accent}>
        [{emoji ? `${emoji} ` : ""}
        {subagent ? "Task" : toolDisplayLabel(name)}]
      </Text>
      <Text>{"  "}</Text>
      <Text dimColor={!subagent} wrap="truncate-end">
        {msg.content}
      </Text>
    </Box>
  );
}

/**
 * A code-change message: a header naming the changed files, then the unified
 * git diff rendered with syntax highlighting in a theme matched to the terminal
 * background (light diff on light terminals, dark on dark).
 */
export function DiffMessage({
  msg,
  theme: diffTheme,
}: {
  msg: Message;
  theme?: DiffTheme;
}): React.ReactElement {
  const files = msg.changedFiles ?? [];
  const header =
    files.length === 0
      ? "code changes"
      : files.length === 1
        ? files[0]!
        : `${files.length} files changed`;
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <Box>
        <Text color={theme.violet} bold>
          {"◆ "}
        </Text>
        <Text dimColor>{header}</Text>
        {files.length > 1 ? (
          <Text dimColor>
            {" "}
            · {files.slice(0, 4).join(", ")}
            {files.length > 4 ? " …" : ""}
          </Text>
        ) : null}
      </Box>
      <DiffView diff={msg.diff ?? ""} theme={diffTheme} />
    </Box>
  );
}

/**
 * Take the first `max` lines of `text` for a compact preview. Returns the sliced
 * text and whether anything was cut (either extra lines, or a very long single
 * line that got hard-capped). Used so a long prompt shows its opening few lines
 * with a "Ctrl-O for full" affordance rather than flooding the transcript.
 */
export function previewLines(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const sliced = lines.slice(0, max);
  let truncated = lines.length > max;
  // Also hard-cap a single runaway line so a one-line 4kB paste can't blow out
  // the frame even when it's "within" the line budget.
  const CAP = max * 200;
  let joined = sliced.join("\n");
  if (joined.length > CAP) {
    joined = joined.slice(0, CAP);
    truncated = true;
  }
  return { text: joined, truncated };
}

/**
 * The pre-execution scope card — surfaced every turn (see the REPL's
 * `onScopeReview` wiring) so the user always sees BOTH their original prompt and
 * the enhanced version the agent will actually run, plus the routed model and an
 * estimated cost. Rendered as a compact preview by default (first few lines of
 * each prompt); `expanded` (Ctrl-O verbose mode) shows the prompts in full.
 */
export function ScopeCard({
  info,
  expanded = false,
}: {
  info: ScopeReviewInfo;
  expanded?: boolean;
}): React.ReactElement {
  const origPrev = expanded
    ? { text: info.originalPrompt, truncated: false }
    : previewLines(info.originalPrompt, 3);
  const enhPrev = expanded
    ? { text: info.enhancedPrompt, truncated: false }
    : previewLines(info.enhancedPrompt, 6);
  const est = formatUsd(info.estimatedCostUsd);
  return (
    <Box paddingX={1} marginY={0} flexDirection="column">
      <Box>
        <Text color={theme.violet} bold>
          {"✦ enhanced "}
        </Text>
        <Text dimColor>· </Text>
        <Text color={theme.violet}>{info.model.split("/").pop()}</Text>
        <Text dimColor> · {info.tier} · </Text>
        <Text color="#FBBF24">est {est}</Text>
        <Text dimColor>
          {" · ~"}
          {humanizeTokens(info.estimatedInputTokens)}→
          {humanizeTokens(info.estimatedOutputTokens)} tok
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Text dimColor>you asked:</Text>
        <Text wrap="wrap">{origPrev.text}</Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Text dimColor>
          {info.context
            ? "enhanced with retrieved context:"
            : "enhanced prompt (no extra context found):"}
        </Text>
        <Text dimColor wrap="wrap">
          {enhPrev.text}
        </Text>
      </Box>
      {origPrev.truncated || enhPrev.truncated ? (
        <Box paddingLeft={2}>
          <Text dimColor>… Ctrl-O for the full prompt</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function MessageViewImpl({
  msg,
  diffTheme,
  expanded = false,
}: {
  msg: Message;
  /** Theme for `role: "diff"` rendering; derived from the terminal background. */
  diffTheme?: DiffTheme;
  /**
   * Verbose (Ctrl-O) mode: render long prompts and the scope card in full rather
   * than a truncated preview. Only affects roles that truncate (`user`, `scope`).
   * NOTE: committed transcript items render through `<Static>` and are baked at
   * their first render, so this reflects the mode active WHEN each line
   * committed — the live in-progress message always tracks the current mode.
   */
  expanded?: boolean;
}): React.ReactElement {
  if (msg.trace) return <TraceView trace={msg.trace} />;
  if (msg.summary) return <TurnSummaryView summary={msg.summary} />;
  if (msg.role === "terminal" && msg.terminalRun)
    return (
      <TerminalRunCard
        run={msg.terminalRun}
        expanded={msg.terminalExpanded ?? false}
      />
    );
  if (msg.role === "diff" && msg.diff)
    return <DiffMessage msg={msg} theme={diffTheme} />;
  if (msg.role === "stage" && msg.stage)
    return <StageBadge stage={msg.stage} />;
  if (msg.role === "scope" && msg.scope)
    return <ScopeCard info={msg.scope} expanded={expanded} />;
  if (msg.role === "user") {
    // Long prompts show their opening lines with a Ctrl-O affordance so a big
    // paste never floods the transcript (verbose mode renders it in full).
    const prev = expanded
      ? { text: msg.content, truncated: false }
      : previewLines(msg.content, 4);
    return (
      <Box paddingX={1} marginY={0} flexDirection="column">
        <Box>
          <Text color={theme.cyan} bold>
            {"❯ "}
          </Text>
          <Text bold wrap="wrap">
            {prev.text}
          </Text>
        </Box>
        {prev.truncated ? (
          <Box paddingLeft={2}>
            <Text dimColor>… Ctrl-O to expand</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (msg.role === "reasoning") {
    // The model's chain-of-thought, rendered dim under a 💭 label so it reads as
    // an aside distinct from the answer. Shown live so the user sees every step
    // of the agent's thinking, not just its conclusion.
    return (
      <Box paddingX={1} marginY={0} flexDirection="column">
        <Text dimColor wrap="wrap">
          <Text color={theme.violet}>💭 thinking </Text>
          {msg.content}
          {msg.streaming && <Text color={theme.violet}>▊</Text>}
        </Text>
      </Box>
    );
  }

  if (msg.role === "tool") return <ToolChip msg={msg} />;

  // assistant — Oxagen speaking. A violet ◆ marker gutters the block so the
  // agent's prose is instantly separable from tool output and thinking asides.
  // While the message is still streaming it renders as plain text (parsing
  // half-finished markdown every frame flickers on unclosed fences); the
  // moment it commits, the prose re-renders through <Markdown> with full
  // emphasis/code/list styling.
  if (msg.streaming) {
    return (
      <Box paddingX={1} marginY={0} flexDirection="column">
        <Text wrap="wrap">
          <Text color={theme.violet} bold>
            ◆{" "}
          </Text>
          {msg.content}
          <Text color={theme.cyan}>▊</Text>
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1} marginY={0}>
      <Text color={theme.violet} bold>
        ◆{" "}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown>{msg.content}</Markdown>
      </Box>
    </Box>
  );
}

/**
 * One transcript row. Wrapped in `React.memo` because the transcript re-renders
 * on a hot path: in full-screen mode `TranscriptViewport` maps the visible
 * committed rows on EVERY frame (each streamed token, the 1Hz clock tick), and
 * every idle re-render of the container would otherwise re-run every row. A
 * committed message object is immutable — the streaming updater in
 * interactive.tsx only ever appends or replaces the LAST turn entry, so all
 * prior rows keep a stable identity across frames — which makes the default
 * shallow prop comparison a perfect fit: unchanged rows skip re-rendering, the
 * one live/streaming row (a fresh object each token) re-renders, and toggling
 * `expanded` (Ctrl-O) changes the prop so every row re-renders as intended.
 * (In inline mode `<Static>` already prevents re-render of committed rows, so
 * the memo is simply harmless there.)
 */
export const MessageView = React.memo(MessageViewImpl);

// ── End-of-turn summary card ──────────────────────────────────────────────────

/** One right-aligned label/value row inside the summary card. */
function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text>{children}</Text>
    </Box>
  );
}

/**
 * The headline outcome of a turn, as a rounded card: the completeness verdict,
 * the advisor "quality" score with the judge's reason for it, the files
 * touched, and the priced cost. The border warms green when complete and amber
 * when the judge still sees gaps.
 */
export function TurnSummaryView({
  summary,
}: {
  summary: TurnSummary;
}): React.ReactElement {
  const { complete, quality, qualityReason, filesTouched, costUsd, judged } =
    summary;
  // The judge's reasoning is a paragraph of chain-of-thought; cap it so the
  // card stays a card. The full verdict is always available via /replay.
  const reason =
    qualityReason && qualityReason.length > 280
      ? qualityReason.slice(0, 280).trimEnd() + "…"
      : qualityReason;
  const color = complete ? "#34D399" : "#FBBF24";
  const files =
    filesTouched.length === 0
      ? "none"
      : filesTouched.length === 1
        ? (filesTouched[0] as string)
        : `${filesTouched[0]} (+${filesTouched.length - 1})`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginY={1}
      alignSelf="flex-start"
    >
      <Box>
        <Text color={color} bold>
          {complete ? "✓ complete" : "⚠ gaps remain"}
        </Text>
        {judged && typeof quality === "number" ? (
          <>
            <Text dimColor>{"     quality "}</Text>
            <Text color={scoreColor(quality)} bold>
              {quality}/100
            </Text>
          </>
        ) : null}
      </Box>
      {!judged ? (
        <SummaryRow label="review">
          <Text dimColor>not judged (bare mode)</Text>
        </SummaryRow>
      ) : null}
      {judged && reason ? (
        <SummaryRow label="reason">
          <Text dimColor wrap="wrap">
            {reason}
          </Text>
        </SummaryRow>
      ) : null}
      <SummaryRow label="files">
        <Text
          color={filesTouched.length > 0 ? theme.cyan : undefined}
          dimColor={filesTouched.length === 0}
        >
          {files}
        </Text>
      </SummaryRow>
      <SummaryRow label="cost">
        <Text color="#FBBF24">{formatUsd(costUsd)}</Text>
      </SummaryRow>
    </Box>
  );
}

// ── Thinking Indicator ────────────────────────────────────────────────────────

/**
 * After this many seconds with no *completed* call (progress), the turn is close
 * to the inactivity guard's window and we warn the user. This is NOT a turn cap —
 * a turn runs as long as calls keep completing (see agent/timeouts.ts). It just
 * signals "nothing has landed in a while" so a genuinely hung turn is visible.
 */
const IDLE_WARN_SEC = 60;

/**
 * Seconds of silence after which we surface an explicit "still working"
 * reassurance. A long, healthy step (a big `bash` test run, a silent fleet
 * subagent) streams nothing while it executes, so the ONLY thing that moves is
 * this indicator's spinner + elapsed clock — and a user who sees no *substantive*
 * change for ~10s starts to wonder if it hung. Well under that, at this
 * threshold, we start naming the current activity + a reassurance so there is
 * always a meaningful signal on screen, not just a ticking number.
 */
const HEARTBEAT_SEC = 8;

/**
 * Animated "the agent is working" indicator: a braille spinner, elapsed
 * seconds, a live output-token estimate, the CURRENT activity (the stage/tool in
 * flight), and — crucially — seconds since the last completed call (progress).
 * There is NO countdown to an auto-cancel deadline, because a turn is bounded by
 * progress and per-call timeouts, not by total elapsed time: long, healthy work
 * must not look like it is "running out of time". Instead, once a step has been
 * silent past {@link HEARTBEAT_SEC} the indicator shows a "still working"
 * reassurance (naming the activity when known) so the screen never goes ~10s
 * without a meaningful update; the idle figure then warms amber → red only if the
 * silence stretches toward the inactivity guard's window. It runs its own ~100ms
 * timer so it animates independently of streaming.
 */
export function ThinkingIndicator({
  startedAt,
  getTokens,
  getLastProgressAt,
  getActivity,
}: {
  startedAt: number;
  getTokens: () => number;
  /** Live getter for the timestamp of the last completed call (delta/tool/stage). */
  getLastProgressAt?: () => number | null;
  /**
   * Live getter for a short label of what's happening RIGHT NOW (the in-flight
   * stage or tool, e.g. "executing" / "bash · pnpm test" / "planning the work").
   * Shown so a silent step still tells the user what it's doing.
   */
  getActivity?: () => string | null;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsed = Math.round(Math.max(0, now - startedAt) / 1000);
  const tokens = getTokens();
  const activity = getActivity?.() ?? null;

  // Seconds since the last unit of progress landed. Drives the reassurance +
  // idle warning; a normal fast turn (progress landing constantly) stays clean.
  const lastProgressAt = getLastProgressAt?.() ?? null;
  const idleSec =
    lastProgressAt != null
      ? Math.round(Math.max(0, now - lastProgressAt) / 1000)
      : 0;
  const heartbeat = idleSec >= HEARTBEAT_SEC;
  const idleColor =
    idleSec >= IDLE_WARN_SEC * 2
      ? "#F87171"
      : idleSec >= IDLE_WARN_SEC
        ? "#FBBF24"
        : undefined;

  return (
    <Box paddingX={1}>
      <Text color="#FBBF24" bold>
        {SPINNER[frame % SPINNER.length]}{" "}
      </Text>
      <Text color="#FBBF24">
        {heartbeat ? "Still working… " : "Thinking… "}
      </Text>
      <Text dimColor>
        {elapsed}s{tokens > 0 ? ` · ~${humanizeTokens(tokens)} tok` : ""}
      </Text>
      {activity ? <Text color={theme.cyan}>{` · ${activity}`}</Text> : null}
      {heartbeat ? (
        <Text color={idleColor ?? "#FBBF24"}>{` · working ${idleSec}s`}</Text>
      ) : null}
      <Text dimColor> · esc to cancel</Text>
    </Box>
  );
}

// ── Fun: a rocket duels a UFO across the status rail ────────────────────────

// Sprites are monochrome geometric glyphs — no color emoji — so they read the
// same in any terminal theme. The rocket idles on a flickering thrust flame
// and snaps into a recoil frame the instant it fires; the UFO patrols a
// weaving beat and pulses its running light, mostly taking the hit and
// blooming into a brief explosion, occasionally weaving clear for a
// near-miss flyby.
const ROCKET = ["}=>", "-=>"];
const ROCKET_RECOIL = "{=>";
const ROCKET_IDLE = "|=>";
const ROCKET_LEN = 3;
const UFO = ["<●>", "<○>"];
const UFO_LEN = 3;
const EXPLOSION = ["✳✳✳", " ✸ "]; // flash, then dissipate to a single spark
const BOLT_HEAD = "•";
const BOLT_TRAIL = "·";
const BOLT_SPEED = 3; // cells advanced per tick — a snappy tracer, not a crawl

/** Write `sprite` into the fixed-width lane at `at`, clipping at both edges. */
function placeSprite(lane: string[], at: number, sprite: string): void {
  for (let i = 0; i < sprite.length; i++) {
    const idx = at + i;
    if (idx >= 0 && idx < lane.length) lane[idx] = sprite[i] as string;
  }
}

/** Bounces `n` back and forth across [0, span] — the UFO's weaving patrol. */
function triangleWave(n: number, span: number): number {
  if (span <= 0) return 0;
  const period = span * 2;
  const m = ((n % period) + period) % period;
  return m <= span ? m : period - m;
}

/** Whether half-open ranges [aStart, aStart+aLen) and [bStart, bStart+bLen) intersect. */
function overlaps(
  aStart: number,
  aLen: number,
  bStart: number,
  bLen: number,
): boolean {
  return aStart < bStart + bLen && bStart < aStart + aLen;
}

/**
 * Pure renderer for one row of the rocket-vs-UFO duel, at a fixed `width`.
 * When `active` the rocket fires on a steady cadence while the UFO weaves a
 * patrol near the far end of the lane; most bolts land and bloom into a brief
 * explosion before the UFO reforms, but the weave occasionally carries it
 * clear of the shot for a near-miss flyby instead. Kept pure (no timers, no
 * React) so every frame is deterministic and unit-testable.
 */
export function renderInvadersLane(
  tick: number,
  width: number,
  active: boolean,
): string {
  const W = Math.max(14, Math.min(width, 30));
  const lane: string[] = new Array<string>(W).fill(" ");
  const muzzle = ROCKET_LEN; // column right after the rocket's nose

  if (!active) {
    placeSprite(lane, 0, ROCKET_IDLE);
    placeSprite(lane, W - UFO_LEN, UFO[0] as string);
    return lane.join("");
  }

  // The UFO patrols a weave zone near the far end, well clear of the rocket.
  const ufoRight = W - UFO_LEN;
  const ufoLeft = Math.max(muzzle + 3, ufoRight - 5);
  const weaveSpan = Math.max(1, ufoRight - ufoLeft);
  const ufoAt = (t: number): number => ufoLeft + triangleWave(t, weaveSpan);

  // The rocket fires every `cycle` ticks: a recoil/muzzle-flash tick spawns
  // the bolt, which streaks out at BOLT_SPEED cells/tick until it lands a hit
  // or clears the lane, followed by a short beat before it reloads.
  const flightTicks = Math.ceil((W - muzzle) / BOLT_SPEED);
  const cycle = flightTicks + 2;
  const cyclePos = tick % cycle;
  const volleyStart = tick - cyclePos;

  // Whether (and when) this volley's bolt connects is a pure function of the
  // volley's start tick, so hits and near-misses fall out of the rocket/UFO
  // phase relationship instead of a coin flip.
  let hitFrame = -1;
  for (let f = 0; f < flightTicks; f++) {
    const boltAt = muzzle + f * BOLT_SPEED;
    if (overlaps(boltAt, 1, ufoAt(volleyStart + f), UFO_LEN)) {
      hitFrame = f;
      break;
    }
  }

  placeSprite(
    lane,
    0,
    cyclePos === 0 ? ROCKET_RECOIL : (ROCKET[tick % 2] as string),
  );

  if (hitFrame >= 0 && cyclePos >= hitFrame) {
    // The bolt has landed — flash the impact, then let the UFO reform and
    // resume its patrol for the rest of the beat before the next volley.
    const sinceHit = cyclePos - hitFrame;
    if (sinceHit < EXPLOSION.length) {
      placeSprite(
        lane,
        ufoAt(volleyStart + hitFrame),
        EXPLOSION[sinceHit] as string,
      );
    } else {
      placeSprite(lane, ufoAt(tick), UFO[tick % 2] as string);
    }
    return lane.join("");
  }

  if (cyclePos < flightTicks) {
    // Still in flight (a miss this volley, or a hit not yet reached) — the
    // bolt leaves a fading trail behind its head as it streaks across.
    const boltAt = muzzle + cyclePos * BOLT_SPEED;
    if (boltAt - 1 >= muzzle) lane[boltAt - 1] = BOLT_TRAIL;
    if (boltAt < W) lane[boltAt] = BOLT_HEAD;
  }
  placeSprite(lane, ufoAt(tick), UFO[tick % 2] as string);
  return lane.join("");
}

/**
 * A whimsical bottom-rail animation: a rocket dueling a weaving UFO while the
 * agent is busy, standing down to a parked rocket and a calm UFO when idle.
 * Runs its own ~140ms timer (only while `active`) so it animates independently
 * of the stream, then goes still — no perpetual redraw — the moment the turn
 * ends.
 */
export function SpaceInvaders({
  active,
  width = 24,
}: {
  active: boolean;
  width?: number;
}): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 140);
    return () => clearInterval(id);
  }, [active]);
  const lane = renderInvadersLane(active ? tick : 0, width, active);
  return (
    <Box paddingX={1}>
      <Text dimColor>{active ? "▸ " : "· "}</Text>
      <Text color={theme.cyan}>{lane}</Text>
    </Box>
  );
}

// ── Status Bar ────────────────────────────────────────────────────────────────

/** Second-line description of the active permission posture. */
function permissionLine(mode: PermissionMode): {
  label: string;
  color: string;
} {
  switch (mode) {
    case "bypass":
      return { label: "bypass permissions on", color: "#FB7185" };
    case "acceptEdits":
      return { label: "auto-accept edits on", color: "#FBBF24" };
    case "readonly":
      return { label: "read-only", color: "#FBBF24" };
    default:
      return { label: "ask before edits", color: theme.cyan };
  }
}

export function StatusLine({
  model,
  branch,
  inputTokens,
  outputTokens,
  cacheHit,
  cacheMiss,
  costUsd,
  pipelineOn,
  verboseOn,
  effort,
  mode = "ask",
  turnOutputTokens = 0,
  turnCostUsd = 0,
}: {
  model: string;
  /** Current git branch (undefined = not a repo / unknown; the chip is hidden). */
  branch?: string;
  inputTokens: number;
  outputTokens: number;
  /** Cumulative prompt tokens served from cache (a "hit"). */
  cacheHit: number;
  /** Cumulative prompt tokens billed fresh (a "miss"). */
  cacheMiss: number;
  /** Cumulative estimated session cost, USD. */
  costUsd: number;
  /** Output tokens accumulated in the CURRENT turn (live; 0 = idle/none). */
  turnOutputTokens?: number;
  /** Estimated cost of the CURRENT turn, USD (live; 0 = idle/none). */
  turnCostUsd?: number;
  /** Whether the eval→enhance→judge pipeline is active (undefined = don't show). */
  pipelineOn?: boolean;
  /** Whether verbose telemetry capture is active (undefined = don't show). */
  verboseOn?: boolean;
  /** Active reasoning effort (undefined = model default; chip hidden). */
  effort?: string;
  /** Current permission posture (drives the second line). */
  mode?: PermissionMode;
}): React.ReactElement {
  const sep = <Text dimColor>{"  │  "}</Text>;
  const perm = permissionLine(mode);
  const cost =
    costUsd > 0 ? `~$${costUsd.toFixed(costUsd < 100 ? 2 : 0)}` : "~$0.00";
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Line 1 — model · branch · tokens · cache · cost */}
      <Box>
        <Text color={theme.violet} bold>
          {model.split("/").pop()}
        </Text>
        {branch ? (
          <>
            {sep}
            <Text color={theme.cyan}>{branch}</Text>
          </>
        ) : null}
        {sep}
        <Text color={theme.cyan}>↑{humanizeTokens(inputTokens)} </Text>
        <Text color="#34D399">↓{humanizeTokens(outputTokens)}</Text>
        {sep}
        <Text dimColor>cache </Text>
        <Text color="#34D399">{humanizeTokens(cacheHit)}hit</Text>
        <Text dimColor> / </Text>
        <Text color="#FB7185">{humanizeTokens(cacheMiss)}miss</Text>
        {sep}
        <Text color="#FBBF24">{cost}</Text>
        {turnOutputTokens > 0 || turnCostUsd > 0 ? (
          <Text color="#34D399">
            {"  ▲ turn +"}
            {humanizeTokens(turnOutputTokens)}
            {turnCostUsd > 0 ? ` ${formatUsd(turnCostUsd)}` : ""}
          </Text>
        ) : null}
        {effort ? (
          <>
            {sep}
            <Text dimColor>effort:</Text>
            <Text color={theme.violet}>{effort}</Text>
          </>
        ) : null}
        {verboseOn ? (
          <>
            {sep}
            <Text color={theme.cyan}>verbose</Text>
          </>
        ) : null}
        {pipelineOn === true ? (
          <>
            {sep}
            <Text color="#34D399" bold>
              🏋️ pipeline activated
            </Text>
          </>
        ) : pipelineOn === false ? (
          <>
            {sep}
            <Text color="#FB7185">bare</Text>
          </>
        ) : null}
      </Box>
      {/* Line 2 — permission posture + cycle hint */}
      <Box>
        <Text color={perm.color} bold>
          {"▶▶ "}
          {perm.label}
        </Text>
        <Text dimColor> (shift+tab to cycle)</Text>
      </Box>
    </Box>
  );
}

// ── Replay / Trace view ───────────────────────────────────────────────────────

/** A tiny 0–100 score bar: "completeness ███████░░░ 72/100". */
function scoreColor(score: number): string {
  if (score >= 70) return "#34D399";
  if (score >= 40) return "#FBBF24";
  return "#FB7185";
}

function ScoreBar({
  label,
  score,
}: {
  label: string;
  score: number;
}): React.ReactElement {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 10);
  return (
    <Box>
      <Text dimColor>{label.padEnd(13)}</Text>
      <Text color={scoreColor(score)}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(10 - filled)}</Text>
      <Text dimColor> {score}/100</Text>
    </Box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.cyan} bold>
        {title}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

function JudgeRoundView({
  verdict,
  round,
}: {
  verdict: JudgeVerdict;
  round: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={round > 0 ? 1 : 0}>
      <Box>
        <Text dimColor>round {round + 1}: </Text>
        <Text color={verdict.complete ? "#34D399" : "#FB7185"} bold>
          {verdict.complete ? "COMPLETE" : "INCOMPLETE"}
        </Text>
        <Text dimColor>
          {" "}
          · {verdict.confidence}% confident · advisor{" "}
          {verdict.model.split("/").pop()}
          {verdict.fallback ? " (heuristic)" : ""}
        </Text>
      </Box>
      {verdict.findings.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {verdict.findings.map((f, i) => (
            <Text key={i} color="#FB7185">
              ✗ {f}
            </Text>
          ))}
        </Box>
      )}
      {verdict.reasoning ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {verdict.reasoning}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Full replay of one turn — the original prompt, how it was evaluated, the context
 * the enhancer injected, the model that was selected and why, and the advisor's
 * completeness verdict(s) with chain of thought. This is the user's window into
 * everything the pipeline did on their behalf.
 */
export function TraceView({ trace }: { trace: TurnTrace }): React.ReactElement {
  const { evaluation: ev, enhancement: en } = trace;
  const cost = formatUsd(trace.usage.costUsd);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text color={theme.violet} bold>
          ↻ replay
        </Text>
        <Text dimColor>
          {" "}
          {trace.id} · {Math.round(trace.durationMs / 100) / 10}s · {cost} ·{" "}
          {trace.finalComplete ? (
            <Text color="#34D399">complete</Text>
          ) : (
            <Text color="#FB7185">gaps remain</Text>
          )}
        </Text>
      </Box>

      <Section title="1 · Original prompt">
        <Text wrap="wrap">{trace.originalPrompt}</Text>
      </Section>

      <Section
        title={`2 · Evaluation${ev.fallback ? " (heuristic)" : ` · ${ev.model.split("/").pop()}`}`}
      >
        <ScoreBar label="completeness" score={ev.completeness} />
        <ScoreBar label="complexity" score={ev.complexity} />
        {ev.missing.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>missing from prompt:</Text>
            {ev.missing.map((m, i) => (
              <Text key={i} color="#FBBF24">
                ? {m}
              </Text>
            ))}
          </Box>
        )}
        {ev.removed.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>pruned as low-value:</Text>
            {ev.removed.map((r, i) => (
              <Text key={i} dimColor>
                − {r}
              </Text>
            ))}
          </Box>
        )}
        {ev.reasoning ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {ev.reasoning}
            </Text>
          </Box>
        ) : null}
      </Section>

      {ev.refinedPrompt !== trace.originalPrompt && (
        <Section title="3 · Refined prompt (noise removed)">
          <Text wrap="wrap">{ev.refinedPrompt}</Text>
        </Section>
      )}

      <Section title={`4 · Injected context · ${en.source}`}>
        {en.resolved.length > 0 ? (
          <Text dimColor>
            code refs: <Text color={theme.cyan}>{en.resolved.join(", ")}</Text>
          </Text>
        ) : (
          <Text dimColor>no code-graph references resolved</Text>
        )}
        <Text dimColor>recalled lessons: {en.lessonCount}</Text>
        {en.context ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {en.context.length > 600
                ? en.context.slice(0, 600) + "…"
                : en.context}
            </Text>
          </Box>
        ) : null}
      </Section>

      <Section title="5 · Model selected">
        <Text>
          <Text color={theme.cyan} bold>
            {trace.selectedModel.split("/").pop()}
          </Text>
          <Text dimColor>
            {" "}
            ({trace.selectedTier}) — {trace.selectionRationale}
          </Text>
        </Text>
      </Section>

      <Section title="6 · Completeness review (advisor)">
        {trace.judgeRounds.length === 0 ? (
          <Text dimColor>not judged (bare mode)</Text>
        ) : (
          trace.judgeRounds.map((v, i) => (
            <JudgeRoundView key={i} verdict={v} round={i} />
          ))
        )}
      </Section>

      <Box marginTop={1}>
        <Text dimColor>
          {trace.steps} steps · {trace.filesTouched.length} file(s) touched
          {trace.filesTouched.length > 0
            ? `: ${trace.filesTouched.slice(0, 5).join(", ")}`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}

/** One-line summary of a trace for the `/traces` list. */
export function summarizeTrace(trace: TurnTrace, index: number): string {
  const mark = trace.finalComplete ? "✓" : "✗";
  const prompt =
    trace.originalPrompt.length > 56
      ? trace.originalPrompt.slice(0, 56) + "…"
      : trace.originalPrompt;
  const model = trace.selectedModel.split("/").pop();
  return `${index + 1}. ${mark} ${prompt}  [${model} · ${formatUsd(trace.usage.costUsd)}]`;
}
