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
 * paths, and `absoluteHookCommandProblem` refuses a relative one rather
 * than letting enroll write a file that would fail to spawn on every tool
 * call. A bare program name is left alone: that is a PATH lookup, which does
 * not depend on the working directory.
 *
 * **No MCP entry is written.** Cursor reads `~/.cursor/mcp.json` and accepts a
 * remote entry (`{"url": "http://localhost:3000/mcp"}` is Cursor's own
 * example), so unlike Claude Desktop no stdio shim would be needed and
 * pointing Cursor at the collector's loopback gateway would cost one member.
 * It is still the wrong thing to add. The gateway exists for the connected
 * tier (ADR-078), where no hook surface exists and the only calls Oxagen can
 * see are the ones routed through it. Cursor has a hook surface, and that
 * hook sees the MCP call too: `preToolUse` fires for `MCP:<tool_name>` like
 * any other tool. An MCP entry here would record the same call twice, once
 * through the hook and once through the gateway, and put one harness on two
 * tiers at the same time, which is the thing ADR-078 §2 says no surface may
 * do. The toolbelt is a separate offer, made on its own terms, not a
 * side-effect of enrolling a harness.
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
export function cursorHooksShapeProblem(document: unknown): string | undefined {
  return documentShapeProblem(document, ["hooks"], "hooks");
}

/**
 * Why this hook command would not resolve from Cursor's user-hook working
 * directory, or undefined when it will.
 *
 * Cursor runs a user hook from `~/.cursor/`, so a token that is a relative
 * path (`./hooks/tacho.sh`, `bin/tacho.mjs`) is looked for under Cursor's own
 * config directory, where nothing of Oxagen's lives. An absolute path is
 * fine, and so is a bare program name with no separator in it: that is a PATH
 * lookup, and PATH does not depend on the working directory. So this refuses
 * exactly the broken case and nothing else, and names the token so an
 * operator can see what was refused.
 */
export function absoluteHookCommandProblem(
  hookCommand: string,
): string | undefined {
  for (const raw of hookCommand.match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
    const token = raw.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    if (token.startsWith("-")) continue;
    const separated = token.includes("/") || token.includes("\\");
    if (!separated) continue;
    const absolute =
      token.startsWith("/") ||
      token.startsWith("\\\\") ||
      /^[A-Za-z]:[\\/]/.test(token);
    if (!absolute)
      return `the hook command ${JSON.stringify(hookCommand)} contains the relative path ${JSON.stringify(token)}, and Cursor runs user hooks from ~/.cursor/, so it would not be found`;
  }
  return undefined;
}

/**
 * How long Cursor waits for one hook, in seconds.
 *
 * An event Claude Code also runs as a command hook takes that budget. An
 * event Oxagen enforces takes `PreToolUse`'s, whether or not Claude Code has
 * a counterpart for it: `subagentStart` is Cursor's own, it carries
 * `failClosed: true`, and the daemon can spend up to fifteen seconds
 * refreshing a stale bundle through `ControlClient`. On the five-second
 * telemetry budget Cursor killed the hook first and `failClosed` turned that
 * into a deny, so a launch the mandate permits was refused because the
 * answer did not arrive in time. Enforcement is named here rather than
 * listed, so a future veto point cannot inherit the telemetry budget by
 * being left out of a condition.
 *
 * Everything else is telemetry: after the fact, nothing left to permit, and
 * a long wait there would only slow the agent down.
 */
export function cursorHookTimeoutS(event: CursorHookEventName): number {
  const claude = CURSOR_TO_CLAUDE_EVENT[event];
  if (Object.hasOwn(COMMAND_HOOK_TIMEOUTS_S, claude))
    return COMMAND_HOOK_TIMEOUTS_S[
      claude as keyof typeof COMMAND_HOOK_TIMEOUTS_S
    ];
  if (CURSOR_ENFORCEMENT_EVENTS.includes(event))
    return COMMAND_HOOK_TIMEOUTS_S.PreToolUse;
  return TELEMETRY_TIMEOUT_S;
}

/** The entries Tacho installs into `hooks.json`, by Cursor event name. */
export function cursorHookEntries(
  config: HookInstallConfig,
): Record<CursorHookEventName, HookEntry[]> {
  const out = {} as Record<CursorHookEventName, HookEntry[]>;
  for (const event of CURSOR_HOOK_EVENTS) {
    const base = commandHookEntry(config, cursorHookTimeoutS(event), "cursor");
    out[event] = [
      { ...base, failClosed: CURSOR_ENFORCEMENT_EVENTS.includes(event) },
    ];
  }
  return out;
}

/**
 * Whether one entry in a user's `hooks.json` is Tacho's. A user's file can
 * hold anything where an entry should be, and whatever that is, it is not
 * ours and it must not throw on the way to saying so. `isTachoEntry` reads
 * `entry.type`, which throws on a `null` in a hook list, and `status` is the
 * command that would have crashed on it.
 */
function isOurs(entry: unknown, enrollmentId?: string): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    isTachoEntry(entry as HookEntry, enrollmentId)
  );
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
  // Cursor's schema requires a positive integer, so a numeric-but-invalid
  // version (0, -1, 1.5) is replaced rather than preserved. Keeping it would
  // leave a document Cursor refuses to load while enrolment reported that it
  // had written every hook, which is the worst pairing available here: a
  // machine the fleet lists as covered and nothing on it reads the file.
  if (
    typeof document.version !== "number" ||
    !Number.isInteger(document.version) ||
    document.version < 1
  )
    document.version = CURSOR_HOOKS_VERSION;
  const hooks = { ...(document.hooks ?? {}) };
  for (const [event, entries] of Object.entries(cursorHookEntries(config))) {
    const foreign = (hooks[event] ?? []).filter(
      (entry) => !isOurs(entry, config.enrollmentId),
    );
    hooks[event] = [...foreign, ...entries];
  }
  document.hooks = hooks;
  return { document, changed: JSON.stringify(document) !== before };
}

/**
 * Remove Tacho's entries (one enrollment, or any) and drop emptied events.
 *
 * `version` always stays, including when it is all that is left. Dropping it
 * there does clear the `{"version":1}` that an `unenroll --purge` used to
 * leave behind, and that leftover is real: `mergeCursorHooks` wrote it on a
 * machine with no `hooks.json`, and the file and its `.cursor` directory
 * survived because of it. But this function is handed a document and cannot
 * see whose file it is, and `{"version": 1}` is also what someone who started
 * a `hooks.json` and never wrote a hook has. Emptying that reports a change
 * on a file holding nothing of ours and puts `{}` where their content was.
 *
 * `HarnessFiles.settle` draws the line instead, from the receipt: a file
 * Tacho created whose bytes are still the ones Tacho last wrote is taken
 * back, scaffolding and all, and a file the user brought is restored.
 */
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
      const kept = entries.filter((entry) => !isOurs(entry, enrollmentId));
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) document.hooks = hooks;
    else delete document.hooks;
  }
  // `version` is deliberately left, even when it is all that remains. It is
  // the one key this writer adds to a document it created, so dropping it
  // here looks like the way to let `HarnessFiles.settle` take the file back —
  // but this function cannot see whose file it is. A user whose
  // `hooks.json` is `{"version": 1}` and nothing else holds nothing of ours,
  // and emptying it would report a change on a file we never wrote into and
  // put `{}` where their content was. `settle` makes that distinction with
  // the receipt instead: a file Tacho created whose bytes are still the ones
  // Tacho last wrote is deleted, scaffolding and all, and a file the user
  // brought is restored from its backup.
  return { document, changed: JSON.stringify(document) !== before };
}

/**
 * Whether a stripped `hooks.json` holds nothing but the `version` this
 * writer had to add itself.
 *
 * This is the one fact `HarnessFiles.settle` cannot work out on its own, and
 * the reason the strip above leaves `version` alone: the document is the
 * same either way, and only the writer knows that `version` is its own. An
 * empty document is not vestigial by this test but is already blank, which
 * `settle` handles without asking.
 */
export function cursorDocumentIsVestigial(
  document: CursorHooksDocument,
): boolean {
  const keys = Object.keys(document);
  // The value, not only the key. `mergeCursorHooks` writes `version` only when
  // the document does not already carry one, precisely so that an operator who
  // pinned a future schema version keeps it — and then this predicate called
  // the result our scaffolding and `settle` deleted their file with the pin in
  // it. Tacho can only take back the value Tacho wrote; any other positive
  // integer came from the operator and the file is theirs.
  return (
    keys.length === 1 &&
    keys[0] === "version" &&
    document.version === CURSOR_HOOKS_VERSION
  );
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
    // A value that is not a list is read as no entries rather than trusted.
    // A hand-edited `{"hooks":{"preToolUse":null}}` reaches here through
    // `tacho status`, which is the command someone runs to find out what is
    // wrong with their file, and it threw on the `.filter` instead of
    // reporting the event missing.
    const raw = document.hooks?.[event];
    const entries = Array.isArray(raw) ? raw : [];
    const ours = entries.filter((entry) => isOurs(entry, enrollmentId));
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
