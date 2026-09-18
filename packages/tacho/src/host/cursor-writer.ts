/**
 * The Cursor hooks writer (verified 2026-09-18 against
 * https://cursor.com/docs/agent/hooks and
 * https://cursor.com/docs/cli/reference/configuration, both fetched that day;
 * neither page carries a visible date).
 *
 * Cursor reads `{"version": 1, "hooks": {"<event>": [{...}]}}`. Unlike Claude
 * Code and Codex, the value of an event is a flat list of hook definitions
 * rather than a list of `{matcher, hooks: [...]}` groups, so the group
 * helpers in `codex-writer.ts` do not apply and this module carries its own
 * merge, strip and presence over entries. Entries are still recognised the
 * one way every writer here recognises them: by the enrollment id in the
 * command line (`isTachoEntry`), so a foreign hook is never touched.
 *
 * Two facts about Cursor drive the rest of this module.
 *
 * **Cursor fails open.** A crash, a timeout, or an unexpected non-zero exit
 * is logged and the action proceeds, unless the hook sets `failClosed: true`,
 * which makes a failure (crash, timeout, non-zero exit, and "no output")
 * block instead. Every hook Oxagen registers at a veto point therefore
 * carries `failClosed: true`: without it a dead collector silently means
 * allow, which is a mandate that does not hold. The telemetry-only events
 * carry `failClosed: false`, which is the same call this repo already made
 * for Claude Code's HTTP hooks and Codex's telemetry command hooks: after a
 * tool has run there is nothing left to permit, so failing closed there would
 * turn an observability outage into an unusable Cursor. `tacho-hook` is built
 * never to exit non-zero and never to print nothing (`runHookProcess`), so
 * what `failClosed` actually covers is the process dying or running past its
 * timeout.
 *
 * **User hooks run with cwd `~/.cursor/`.** Cursor documents project hooks as
 * running from the project root and user hooks from `~/.cursor/`, and a
 * definition's `command` may be "a shell string, an absolute path, or a
 * relative path". Oxagen writes user-scope hooks, so the command must be an
 * absolute path: a relative one would resolve against Cursor's own config
 * directory. `runtimeCommands()` already produces absolute, shell-quoted
 * paths, and `absoluteHookCommandProblem` refuses anything else rather than
 * letting enroll write a file that would fail to spawn on every tool call.
 *
 * Enterprise, team and project `hooks.json` files sit above the user one, and
 * Cursor runs all matching hooks from every source and merges the answers:
 * "any `deny` wins over `ask`, and `ask` wins over `allow`, regardless of
 * source". So a customer's own hook cannot override an Oxagen deny, and
 * writing at user scope is enough for the mandate to hold.
 */
import { join } from "node:path";
import {
  CURSOR_ENFORCEMENT_EVENTS,
  CURSOR_HOOK_EVENTS,
  CURSOR_TO_CLAUDE_EVENT,
  type CursorHookEventName,
} from "../claude-code/cursor-adapter";
import {
  COMMAND_HOOK_TIMEOUTS_S,
  commandHookEntry,
  documentShapeProblem,
  type HookEntry,
  type HookInstallConfig,
  isTachoEntry,
} from "./settings-writer";

/** Cursor's `hooks.json`: a schema version and a flat entry list per event. */
export type CursorHooksDocument = Record<string, unknown> & {
  version?: unknown;
  hooks?: Record<string, HookEntry[]>;
};

/** The schema version Cursor documents ("Must be a positive integer (use `1`)"). */
export const CURSOR_HOOKS_VERSION = 1;

const TELEMETRY_TIMEOUT_S = 5;

/**
 * Cursor's config directory. `CURSOR_CONFIG_DIR` overrides it, and on
 * Linux and BSD `XDG_CONFIG_HOME` puts it at `$XDG_CONFIG_HOME/cursor`;
 * otherwise it is `~/.cursor`.
 *
 * Honest caveat: Cursor documents those two variables for the CLI's
 * configuration directory (`cli-config.json`), and the hooks page names only
 * `~/.cursor/hooks.json`. Whether the hooks loader follows the same
 * resolution is not documented either way, which is why `cursorHooksPaths`
 * writes both when they differ instead of betting on one reading.
 */
export function cursorConfigDir(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): string {
  const explicit = env["CURSOR_CONFIG_DIR"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (
    platform !== "darwin" &&
    platform !== "win32" &&
    xdg !== undefined &&
    xdg.length > 0
  )
    return join(xdg, "cursor");
  return join(home, ".cursor");
}

/**
 * Every user-scope `hooks.json` Oxagen writes, most likely first. When the
 * resolved config directory is not `~/.cursor`, the default is written too:
 * only one of the two is the file Cursor actually reads, nothing documents
 * which, and the unread one is inert while the read one carries the mandate.
 * An enrollment that guessed wrong would leave a machine reported as covered
 * whose hooks nothing runs.
 */
export function cursorHooksPaths(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): string[] {
  const resolved = join(cursorConfigDir(home, platform, env), "hooks.json");
  const fallback = join(home, ".cursor", "hooks.json");
  return resolved === fallback ? [resolved] : [resolved, fallback];
}

/** Why a `hooks.json` document cannot be merged into, or undefined when it can. */
export function cursorHooksShapeProblem(
  document: unknown,
): string | undefined {
  return documentShapeProblem(document, ["hooks"], "hooks");
}

/**
 * A `command` that is not an absolute path (optionally shell-quoted, and for
 * the bundled layout followed by an interpreter argument that is itself an
 * absolute path) would resolve against `~/.cursor/`, where nothing of
 * Oxagen's lives. The message names the command so the operator can see what
 * was refused.
 */
export function absoluteHookCommandProblem(
  hookCommand: string,
): string | undefined {
  const first = /^'([^']*)'|^"([^"]*)"|^(\S+)/.exec(hookCommand);
  const program = first?.[1] ?? first?.[2] ?? first?.[3] ?? "";
  const absolute = program.startsWith("/") || /^[A-Za-z]:[\\/]/.test(program);
  return absolute
    ? undefined
    : `the hook command ${JSON.stringify(hookCommand)} is not an absolute path, and Cursor runs user hooks from ~/.cursor/, so a relative command would not be found`;
}

function timeoutFor(event: CursorHookEventName): number {
  const claude = CURSOR_TO_CLAUDE_EVENT[event];
  if (
    claude === "SessionStart" ||
    claude === "UserPromptSubmit" ||
    claude === "PreToolUse" ||
    claude === "Stop"
  )
    return COMMAND_HOOK_TIMEOUTS_S[claude];
  return TELEMETRY_TIMEOUT_S;
}

/** The entries Tacho installs into `hooks.json`, by Cursor event name. */
export function cursorHookEntries(
  config: HookInstallConfig,
): Record<CursorHookEventName, HookEntry[]> {
  const out = {} as Record<CursorHookEventName, HookEntry[]>;
  for (const event of CURSOR_HOOK_EVENTS) {
    const base = commandHookEntry(config, timeoutFor(event), "cursor");
    out[event] = [
      { ...base, failClosed: CURSOR_ENFORCEMENT_EVENTS.includes(event) },
    ];
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function documentOf(existing: unknown): CursorHooksDocument {
  return existing !== null && typeof existing === "object"
    ? clone(existing as CursorHooksDocument)
    : {};
}

export interface CursorMergeResult {
  document: CursorHooksDocument;
  changed: boolean;
}

/**
 * Merge Tacho's entries into a `hooks.json` document for one enrollment.
 * Foreign entries survive, earlier entries of the same enrollment are
 * replaced, every other member of the document is left alone, and the input
 * is never mutated. `version` is set only when the document does not already
 * carry one, so an operator who pinned a future schema version keeps it.
 */
export function mergeCursorHooks(
  existing: unknown,
  config: HookInstallConfig,
): CursorMergeResult {
  const document = documentOf(existing);
  const before = JSON.stringify(document);
  if (typeof document.version !== "number")
    document.version = CURSOR_HOOKS_VERSION;
  const hooks = { ...(document.hooks ?? {}) };
  for (const [event, entries] of Object.entries(cursorHookEntries(config))) {
    const foreign = (hooks[event] ?? []).filter(
      (entry) => !isTachoEntry(entry, config.enrollmentId),
    );
    hooks[event] = [...foreign, ...entries];
  }
  document.hooks = hooks;
  return { document, changed: JSON.stringify(document) !== before };
}

/** Remove Tacho's entries (one enrollment, or any) and drop emptied events. */
export function stripCursorHooks(
  existing: unknown,
  enrollmentId?: string,
): CursorMergeResult {
  // Not a hooks document: nothing of ours is in it, and it goes back as it is.
  if (cursorHooksShapeProblem(existing) !== undefined)
    return { document: existing as CursorHooksDocument, changed: false };
  const document = documentOf(existing);
  const before = JSON.stringify(document);
  if (document.hooks !== undefined) {
    const hooks: Record<string, HookEntry[]> = {};
    for (const [event, entries] of Object.entries(document.hooks)) {
      const kept = entries.filter((entry) => !isTachoEntry(entry, enrollmentId));
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) document.hooks = hooks;
    else delete document.hooks;
  }
  return { document, changed: JSON.stringify(document) !== before };
}

export interface CursorHookPresence {
  complete: boolean;
  present: CursorHookEventName[];
  missing: CursorHookEventName[];
  /** Events whose Tacho entry is registered without `failClosed: true`. */
  failOpenEnforcement: CursorHookEventName[];
}

/**
 * Which of Tacho's Cursor hooks are installed for this enrollment, and
 * whether the veto points still fail closed. A hook present but fail-open is
 * reported rather than counted as installed: it records, and it stops
 * denying the moment the collector is not there to answer.
 */
export function cursorHookPresence(
  existing: unknown,
  enrollmentId: string,
): CursorHookPresence {
  const document =
    existing !== null && typeof existing === "object"
      ? (existing as CursorHooksDocument)
      : {};
  const present: CursorHookEventName[] = [];
  const missing: CursorHookEventName[] = [];
  const failOpenEnforcement: CursorHookEventName[] = [];
  for (const event of CURSOR_HOOK_EVENTS) {
    const entries = document.hooks?.[event] ?? [];
    const ours = entries.filter((entry) => isTachoEntry(entry, enrollmentId));
    if (ours.length === 0) {
      missing.push(event);
      continue;
    }
    present.push(event);
    if (
      CURSOR_ENFORCEMENT_EVENTS.includes(event) &&
      !ours.some((entry) => entry["failClosed"] === true)
    )
      failOpenEnforcement.push(event);
  }
  return {
    complete: missing.length === 0 && failOpenEnforcement.length === 0,
    present,
    missing,
    failOpenEnforcement,
  };
}
