/**
 * The Codex CLI hooks writer (spec section 13, verified 2026-09-13 against
 * developers.openai.com/codex/hooks). Codex reads `~/.codex/hooks.json`
 * whose `hooks` member has Claude Code's group shape, receives the same stdin
 * fields (`session_id`, `hook_event_name`, `tool_name`, `tool_input`, `cwd`,
 * `transcript_path`), and honours the same `hookSpecificOutput.
 * permissionDecision` deny answer. The client converts unsupported ask
 * decisions to deny. Two differences drive this module:
 *
 *   - only `type: "command"` hooks exist, so the telemetry events that Claude
 *     Code posts over `http` are command hooks here too (fail open: the hook
 *     answers `{}` when the daemon is down);
 *   - there is no env block and no OpenTelemetry export, so the writer
 *     touches `hooks` only.
 *
 * Every entry carries `--harness codex` so the daemon labels the session.
 *
 * The group merge, strip and presence helpers are shared with Stella's
 * legacy `settings.json` (`stella-writer.ts`), whose `hooks` member has the
 * same group shape.
 */
import {
  COMMAND_HOOK_EVENTS,
  COMMAND_HOOK_TIMEOUTS_S,
  commandHookEntry,
  documentShapeProblem,
  type HookEntry,
  type HookGroup,
  type HookInstallConfig,
  isTachoGroup,
  type SettingsDocument,
} from "./settings-writer";

/** Codex lifecycle events beyond the five enforcement events. */
export const CODEX_TELEMETRY_EVENTS = [
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "Interrupt",
] as const;

export const CODEX_HOOK_EVENTS = [
  ...COMMAND_HOOK_EVENTS,
  ...CODEX_TELEMETRY_EVENTS,
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

const TELEMETRY_TIMEOUT_S = 5;

/**
 * Codex's `additionalContextLimit` for the handlers that answer with text
 * (verified 2026-09-23 against learn.chatgpt.com/docs/hooks, "Large hook
 * output"). Codex spills `additionalContext` past about 2,500 tokens to a
 * file and shows the model a head-and-tail preview, so the steering prefix
 * and the operator messages the daemon delivers would be sealed as delivered
 * while the agent read part of them. The daemon holds one answer under 9,500
 * characters (`ADDITIONAL_CONTEXT_MAX_CHARS` in `collector/hook-handler.ts`),
 * and the limit counts approximate tokens, of which that text is fewer than
 * 10,000 however it is counted.
 */
export const CODEX_ADDITIONAL_CONTEXT_LIMIT = 10_000;

/**
 * The events whose answer carries `additionalContext`: the two that open a
 * turn, and `PostToolUse`, where the daemon delivers a steer mid-turn. Codex
 * reports a configuration warning for the limit on an event that cannot
 * produce context, so no other entry has it.
 */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
]);

function withContextLimit(event: string, entry: HookEntry): HookEntry {
  return CONTEXT_EVENTS.has(event)
    ? { ...entry, additionalContextLimit: CODEX_ADDITIONAL_CONTEXT_LIMIT }
    : entry;
}

/** The hook groups Tacho installs into `hooks.json`, by event. */
export function codexHookEntries(
  config: HookInstallConfig,
): Record<CodexHookEventName, HookGroup[]> {
  const out = {} as Record<CodexHookEventName, HookGroup[]>;
  for (const event of COMMAND_HOOK_EVENTS) {
    const entry = commandHookEntry(
      config,
      COMMAND_HOOK_TIMEOUTS_S[event],
      "codex",
    );
    out[event] = [{ hooks: [withContextLimit(event, entry)] }];
  }
  for (const event of CODEX_TELEMETRY_EVENTS) {
    const entry = commandHookEntry(config, TELEMETRY_TIMEOUT_S, "codex");
    out[event] = [{ hooks: [withContextLimit(event, entry)] }];
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function documentOf(existing: unknown): SettingsDocument {
  return existing !== null && typeof existing === "object"
    ? clone(existing as SettingsDocument)
    : {};
}

export interface CodexMergeResult {
  settings: SettingsDocument;
  changed: boolean;
}

/**
 * Why a parsed `hooks`-keyed document (Codex's `hooks.json`, Stella's legacy
 * `settings.json`) cannot be merged into, or undefined when it can.
 */
export function hooksShapeProblem(document: unknown): string | undefined {
  return documentShapeProblem(document, ["hooks"], "hooks");
}

/**
 * Merge hook groups into a `hooks`-keyed document for one enrollment:
 * foreign groups survive, earlier groups of the same enrollment are
 * replaced, and the input is never mutated.
 */
export function mergeHookGroups(
  existing: unknown,
  entries: Record<string, HookGroup[]>,
  enrollmentId: string,
): CodexMergeResult {
  const settings = documentOf(existing);
  const before = JSON.stringify(settings);
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(entries)) {
    const foreign = (hooks[event] ?? []).filter(
      (group) => !isTachoGroup(group, enrollmentId),
    );
    hooks[event] = [...foreign, ...groups];
  }
  settings.hooks = hooks;
  return { settings, changed: JSON.stringify(settings) !== before };
}

/** Remove Tacho's groups (one enrollment, or any) and drop emptied events. */
export function stripHookGroups(
  existing: unknown,
  enrollmentId?: string,
): CodexMergeResult {
  // Not a hooks document: nothing of ours is in it, and it goes back as it is.
  if (hooksShapeProblem(existing) !== undefined)
    return {
      settings: existing as CodexMergeResult["settings"],
      changed: false,
    };
  const settings = documentOf(existing);
  const before = JSON.stringify(settings);
  if (settings.hooks !== undefined) {
    const hooks: Record<string, HookGroup[]> = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const kept = groups.filter((group) => !isTachoGroup(group, enrollmentId));
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }
  return { settings, changed: JSON.stringify(settings) !== before };
}

export interface HookGroupPresence<E extends string> {
  complete: boolean;
  present: E[];
  missing: E[];
}

/** Which of `events` carry a Tacho group for this enrollment. */
export function hookGroupPresence<E extends string>(
  existing: unknown,
  events: readonly E[],
  enrollmentId: string,
): HookGroupPresence<E> {
  const settings =
    existing !== null && typeof existing === "object"
      ? (existing as SettingsDocument)
      : {};
  const present: E[] = [];
  const missing: E[] = [];
  for (const event of events) {
    const groups = settings.hooks?.[event] ?? [];
    if (groups.some((group) => isTachoGroup(group, enrollmentId)))
      present.push(event);
    else missing.push(event);
  }
  return { complete: missing.length === 0, present, missing };
}

/** Merge Tacho's groups into a `hooks.json` document; foreign groups survive. */
export function mergeCodexHooks(
  existing: unknown,
  config: HookInstallConfig,
): CodexMergeResult {
  return mergeHookGroups(
    existing,
    codexHookEntries(config),
    config.enrollmentId,
  );
}

/** Remove Tacho's groups (one enrollment, or any) from a `hooks.json` document. */
export function stripCodexHooks(
  existing: unknown,
  enrollmentId?: string,
): CodexMergeResult {
  return stripHookGroups(existing, enrollmentId);
}

export type CodexHookPresence = HookGroupPresence<CodexHookEventName>;

/** Which of Tacho's Codex hooks are installed for this enrollment. */
export function codexHookPresence(
  existing: unknown,
  enrollmentId: string,
): CodexHookPresence {
  return hookGroupPresence(existing, CODEX_HOOK_EVENTS, enrollmentId);
}
