/**
 * The Cursor hooks writer (verified 2026-09-18 against
 * cursor.com/docs/agent/hooks). Cursor's agent, in the IDE and in the `agent`
 * CLI, reads the user file `~/.cursor/hooks.json`:
 *
 *   { "version": 1, "hooks": { "preToolUse": [{ "command": "…", "timeout": 15 }] } }
 *
 * Two differences from Codex's file drive this module:
 *
 *   - each event holds a flat list of entries, not Claude Code's
 *     `{ matcher, hooks: [...] }` groups, so merge, strip and presence work
 *     on entries;
 *   - `version: 1` is required at the top level, so the writer sets it when
 *     the file has none and leaves any other value alone.
 *
 * Only command hooks exist for this purpose, so the telemetry events run
 * `tacho-hook` too, with a short timeout; `tacho-hook` answers from the
 * cached bundle when the daemon is down. Every entry carries
 * `--harness cursor`, which routes the payload and the answer through
 * `claude-code/cursor-adapter.ts`.
 *
 * Entries are recognised by the enrollment id in the command, as in every
 * other writer, so a user's own hooks survive every merge and strip.
 */
import type { CursorHookEventName } from "../claude-code/cursor-adapter";
import {
  commandHookEntry,
  documentShapeProblem,
  type HookEntry,
  type HookInstallConfig,
  isTachoEntry,
} from "./settings-writer";

/** Events that can refuse or steer the agent; `tacho-hook` decides them. */
export const CURSOR_COMMAND_HOOK_TIMEOUTS_S = {
  sessionStart: 10,
  beforeSubmitPrompt: 10,
  preToolUse: 15,
  subagentStart: 15,
  stop: 10,
} as const satisfies Partial<Record<CursorHookEventName, number>>;

/** Events that only record. */
export const CURSOR_TELEMETRY_EVENTS = [
  "postToolUse",
  "postToolUseFailure",
  "subagentStop",
  "preCompact",
  "sessionEnd",
] as const satisfies readonly CursorHookEventName[];

export const CURSOR_HOOK_EVENTS = [
  ...(Object.keys(
    CURSOR_COMMAND_HOOK_TIMEOUTS_S,
  ) as (keyof typeof CURSOR_COMMAND_HOOK_TIMEOUTS_S)[]),
  ...CURSOR_TELEMETRY_EVENTS,
] as const;

export type CursorInstalledEvent = (typeof CURSOR_HOOK_EVENTS)[number];

const TELEMETRY_TIMEOUT_S = 5;

export type CursorHooksDocument = Record<string, unknown> & {
  version?: unknown;
  hooks?: Record<string, HookEntry[]>;
};

export interface CursorMergeResult {
  settings: CursorHooksDocument;
  changed: boolean;
}

/** The entries Tacho installs into `hooks.json`, by event. */
export function cursorHookEntries(
  config: HookInstallConfig,
): Record<CursorInstalledEvent, HookEntry[]> {
  const out = {} as Record<CursorInstalledEvent, HookEntry[]>;
  for (const [event, timeout] of Object.entries(
    CURSOR_COMMAND_HOOK_TIMEOUTS_S,
  )) {
    out[event as CursorInstalledEvent] = [
      commandHookEntry(config, timeout, "cursor"),
    ];
  }
  for (const event of CURSOR_TELEMETRY_EVENTS) {
    out[event] = [commandHookEntry(config, TELEMETRY_TIMEOUT_S, "cursor")];
  }
  return out;
}

/** Why a parsed `hooks.json` cannot be merged into, or undefined when it can. */
export function cursorHooksShapeProblem(document: unknown): string | undefined {
  return documentShapeProblem(document, ["hooks"], "hooks");
}

function isOurs(entry: unknown, enrollmentId?: string): boolean {
  // A user's file can hold anything where an entry should be; whatever it
  // is, it is not ours, and it must not throw.
  return (
    typeof entry === "object" &&
    entry !== null &&
    isTachoEntry(entry as HookEntry, enrollmentId)
  );
}

function documentOf(existing: unknown): CursorHooksDocument {
  return existing !== null && typeof existing === "object"
    ? (JSON.parse(JSON.stringify(existing)) as CursorHooksDocument)
    : {};
}

/**
 * Merge Tacho's entries into a `hooks.json` document for one enrollment:
 * foreign entries survive, earlier entries of the same enrollment are
 * replaced, and the input is never mutated.
 */
export function mergeCursorHooks(
  existing: unknown,
  config: HookInstallConfig,
): CursorMergeResult {
  const settings = documentOf(existing);
  const before = JSON.stringify(settings);
  if (settings.version === undefined) settings.version = 1;
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, entries] of Object.entries(cursorHookEntries(config))) {
    const foreign = (hooks[event] ?? []).filter(
      (entry) => !isOurs(entry, config.enrollmentId),
    );
    hooks[event] = [...foreign, ...entries];
  }
  settings.hooks = hooks;
  return { settings, changed: JSON.stringify(settings) !== before };
}

/**
 * Remove Tacho's entries (one enrollment, or any) and drop emptied events.
 * `version` stays while anything else in the document does, because the file
 * is Cursor's and a user's remaining hooks need it. Where the strip empties
 * the document, `version` goes too: `mergeCursorHooks` is what wrote it on a
 * machine that had no `hooks.json`, and `HarnessFiles.settle` removes a file
 * Tacho created only when what is left says nothing.
 */
export function stripCursorHooks(
  existing: unknown,
  enrollmentId?: string,
): CursorMergeResult {
  // Not a hooks document: nothing of ours is in it, and it goes back as it is.
  if (cursorHooksShapeProblem(existing) !== undefined)
    return { settings: existing as CursorHooksDocument, changed: false };
  const settings = documentOf(existing);
  const before = JSON.stringify(settings);
  if (settings.hooks !== undefined) {
    const hooks: Record<string, HookEntry[]> = {};
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const kept = entries.filter((entry) => !isOurs(entry, enrollmentId));
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }
  const remaining = Object.keys(settings);
  if (remaining.length === 1 && remaining[0] === "version")
    delete settings.version;
  return { settings, changed: JSON.stringify(settings) !== before };
}

export interface CursorHookPresence {
  complete: boolean;
  present: CursorInstalledEvent[];
  missing: CursorInstalledEvent[];
}

/** Which of Tacho's Cursor hooks are installed for this enrollment. */
export function cursorHookPresence(
  existing: unknown,
  enrollmentId: string,
): CursorHookPresence {
  const settings =
    existing !== null && typeof existing === "object"
      ? (existing as CursorHooksDocument)
      : {};
  const present: CursorInstalledEvent[] = [];
  const missing: CursorInstalledEvent[] = [];
  for (const event of CURSOR_HOOK_EVENTS) {
    const entries = settings.hooks?.[event];
    if (
      Array.isArray(entries) &&
      entries.some((entry) => isOurs(entry, enrollmentId))
    )
      present.push(event);
    else missing.push(event);
  }
  return { complete: missing.length === 0, present, missing };
}
