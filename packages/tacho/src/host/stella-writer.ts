/**
 * The Stella hooks writer (verified 2026-09-15 against macanderson/stella:
 * `crates/stella-core/src/hooks.rs`, `crates/stella-cli/src/settings/
 * toml_config.rs`). Stella reads user-scope hooks from `$STELLA_HOME/
 * stella.toml` (`~/.stella` by default) or, when no TOML exists, from the
 * legacy `$STELLA_HOME/settings.json`; a TOML file wins whole, so a
 * `settings.json` beside it is ignored. Hence the target rule: write the
 * TOML when it exists, else the JSON when that exists, else create the TOML.
 * Only user scope is written: project scope needs a trust flag the operator
 * did not give.
 *
 * Both formats carry `hooks.<Event> = [{ matcher?, hooks: [{ type:
 * "command", command, timeoutMs? }] }]`: command hooks only, the timeout in
 * milliseconds (camelCase, capped at 600 000 by Stella).
 *
 * Tacho has no TOML dependency and must not grow one, and people keep
 * comments in `stella.toml`, so a parse-and-reserialize round trip is out.
 * The TOML path manages one marker-delimited text block per enrollment,
 * appended at the end of the file and removed byte-for-byte by a strip.
 * Appending `[[hooks.<Event>]]` tables is only valid TOML when the file does
 * not already define that event some other way (an inline array, a dotted
 * key, a standard table); the merge refuses in that case instead of writing
 * a file Stella would then fail to parse.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  hookGroupPresence,
  type HookGroupPresence,
  mergeHookGroups,
  stripHookGroups,
} from "./codex-writer";
import type { TachoPaths } from "./paths";
import {
  COMMAND_HOOK_TIMEOUTS_S,
  commandHookEntry,
  type HookGroup,
  type HookInstallConfig,
} from "./settings-writer";

/** Stella's veto and lifecycle points Tacho records (Stella has no SessionEnd). */
export const STELLA_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
] as const;

export type StellaHookEventName = (typeof STELLA_HOOK_EVENTS)[number];

/** Stella clamps any larger `timeoutMs` to this. */
export const STELLA_MAX_HOOK_TIMEOUT_MS = 600_000;

const TELEMETRY_TIMEOUT_MS = 5_000;

/**
 * Enforcement events keep Claude Code's per-event budgets (in ms);
 * telemetry-only events get 5 s, the same as the Codex telemetry hooks.
 */
export function stellaHookTimeoutMs(event: StellaHookEventName): number {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "Stop":
      return COMMAND_HOOK_TIMEOUTS_S[event] * 1000;
    default:
      return TELEMETRY_TIMEOUT_MS;
  }
}

/** The hook groups Tacho installs for Stella, by event. */
export function stellaHookEntries(
  config: HookInstallConfig,
): Record<StellaHookEventName, HookGroup[]> {
  const command = commandHookEntry(config, 0, "stella").command as string;
  const out = {} as Record<StellaHookEventName, HookGroup[]>;
  for (const event of STELLA_HOOK_EVENTS) {
    out[event] = [
      {
        hooks: [
          { type: "command", command, timeoutMs: stellaHookTimeoutMs(event) },
        ],
      },
    ];
  }
  return out;
}

export type StellaHooksFormat = "toml" | "json";

/** One Stella config file as the CLI reads and writes it. */
export interface StellaHooksFile {
  path: string;
  format: StellaHooksFormat;
  /** The file's bytes, undefined when it does not exist. */
  text: string | undefined;
}

/**
 * Which file carries user-scope hooks: `stella.toml` when it exists, the
 * legacy `settings.json` when only that exists, a new `stella.toml` when
 * neither does. `format` reads that one file regardless of the rule, which
 * is how `unenroll` strips both.
 */
export function readStellaHooksFile(
  paths: Pick<TachoPaths, "stellaToml" | "stellaSettingsJson">,
  format?: StellaHooksFormat,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): StellaHooksFile {
  const chosen: StellaHooksFormat =
    format ??
    (exists(paths.stellaToml)
      ? "toml"
      : exists(paths.stellaSettingsJson)
        ? "json"
        : "toml");
  const path = chosen === "toml" ? paths.stellaToml : paths.stellaSettingsJson;
  return { path, format: chosen, text: exists(path) ? read(path) : undefined };
}

// ---------------------------------------------------------------------------
// TOML: one managed block per enrollment
// ---------------------------------------------------------------------------

const ANY_ENROLLMENT = "tch_[a-z0-9]{22}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stellaBlockStart(enrollmentId: string): string {
  return `# >>> tacho enrollment ${enrollmentId} (managed by tacho; do not edit) >>>`;
}

export function stellaBlockEnd(enrollmentId: string): string {
  return `# <<< tacho enrollment ${enrollmentId} <<<`;
}

/**
 * Every managed block (for one enrollment, or any), with the one line break
 * the merge put before it. The merge adds exactly one break (a blank line
 * when the file ended in a newline, the missing newline when it did not),
 * so removing exactly one restores the original bytes.
 */
function blockPattern(enrollmentId?: string): RegExp {
  const id =
    enrollmentId !== undefined ? escapeRegExp(enrollmentId) : ANY_ENROLLMENT;
  return new RegExp(
    `(?:\\r?\\n)?^# >>> tacho enrollment (${id}) \\(managed by tacho; do not edit\\) >>>\\r?\\n[\\s\\S]*?^# <<< tacho enrollment \\1 <<<(?:\\r?\\n|$)`,
    "gm",
  );
}

/**
 * A TOML basic string. JSON's escapes are TOML's (`\"`, `\\`, `\b`, `\t`,
 * `\n`, `\f`, `\r`, `\uXXXX`) except that TOML also forbids a raw DEL,
 * which JSON leaves alone.
 */
export function tomlBasicString(value: string): string {
  return JSON.stringify(value).replace(//g, "\\u007F");
}

/** The block Tacho appends for one enrollment, ending in a line break. */
export function renderStellaTomlBlock(
  config: HookInstallConfig,
  eol = "\n",
): string {
  const lines: string[] = [stellaBlockStart(config.enrollmentId)];
  const entries = stellaHookEntries(config);
  for (const event of STELLA_HOOK_EVENTS) {
    const hook = entries[event][0]?.hooks[0];
    lines.push(
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${tomlBasicString(String(hook?.command ?? ""))}`,
      `timeoutMs = ${stellaHookTimeoutMs(event)}`,
      "",
    );
  }
  lines.push(stellaBlockEnd(config.enrollmentId));
  return `${lines.join(eol)}${eol}`;
}

/** Remove managed blocks (one enrollment, or any) from TOML text. */
export function stripStellaTomlBlocks(
  text: string,
  enrollmentId?: string,
): string {
  return text.replace(blockPattern(enrollmentId), "");
}

/** `"hooks" . 'PreToolUse'` → `hooks.PreToolUse`. */
function normalizeKey(key: string): string {
  return key
    .split(".")
    .map((part) =>
      part
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .replace(/^'(.*)'$/, "$1"),
    )
    .join(".");
}

/**
 * The hook events an appended `[[hooks.<Event>]]` would collide with:
 * the file defines them as a key (`hooks.PreToolUse = [...]` at the root,
 * `PreToolUse = [...]` under `[hooks]`, `hooks = { ... }`) or as a
 * standard table (`[hooks.PreToolUse]`). Array-of-tables definitions
 * elsewhere in the file are compatible and not reported. Managed blocks are
 * ignored; lines inside multi-line strings are skipped.
 */
export function stellaTomlConflicts(text: string): StellaHookEventName[] {
  const conflicts = new Set<StellaHookEventName>();
  const stripped = stripStellaTomlBlocks(text);
  let header = "";
  let arrayHeader = false;
  let inMultiline: '"""' | "'''" | undefined;
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inMultiline !== undefined) {
      if (line.split(inMultiline).length % 2 === 0) inMultiline = undefined;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    const arrayMatch = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    if (arrayMatch !== null) {
      header = normalizeKey(arrayMatch[1] as string);
      arrayHeader = true;
      continue;
    }
    const tableMatch = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (tableMatch !== null) {
      header = normalizeKey(tableMatch[1] as string);
      arrayHeader = false;
      for (const event of STELLA_HOOK_EVENTS) {
        if (header === `hooks.${event}`) conflicts.add(event);
      }
      continue;
    }
    const keyMatch =
      /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=(.*)$/.exec(
        line,
      );
    if (keyMatch === null) continue;
    const value = (keyMatch[2] as string).trim();
    for (const quote of ['"""', "'''"] as const) {
      if (value.split(quote).length % 2 === 0) inMultiline = quote;
    }
    // A key inside an array-of-tables element belongs to that element, not
    // to a static path an appended table could collide with.
    if (arrayHeader) continue;
    const key = normalizeKey(keyMatch[1] as string);
    const full = header.length > 0 ? `${header}.${key}` : key;
    for (const event of STELLA_HOOK_EVENTS) {
      if (
        full === "hooks" ||
        full === `hooks.${event}` ||
        full.startsWith(`hooks.${event}.`)
      ) {
        conflicts.add(event);
      }
    }
  }
  return STELLA_HOOK_EVENTS.filter((event) => conflicts.has(event));
}

/** The events inside this enrollment's managed block. */
function tomlBlockEvents(
  text: string,
  enrollmentId: string,
): Set<StellaHookEventName> {
  const events = new Set<StellaHookEventName>();
  for (const match of text.matchAll(blockPattern(enrollmentId))) {
    for (const header of match[0].matchAll(
      /^\s*\[\[\s*hooks\.([A-Za-z]+)\s*\]\]\s*$/gm,
    )) {
      const event = header[1] as StellaHookEventName;
      if ((STELLA_HOOK_EVENTS as readonly string[]).includes(event))
        events.add(event);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Both formats
// ---------------------------------------------------------------------------

export type StellaMergeResult =
  | { ok: true; file: StellaHooksFile; changed: boolean }
  | { ok: false; error: string };

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

/**
 * Install this enrollment's hooks into the file. Refuses, writing nothing,
 * when the TOML defines a hook event in a form the managed block would
 * duplicate, or when the JSON is not JSON (rewriting it would lose the
 * operator's settings).
 */
export function mergeStellaHooks(
  file: StellaHooksFile,
  config: HookInstallConfig,
): StellaMergeResult {
  if (file.format === "json") {
    let existing: unknown;
    try {
      existing = parseJson(file.text);
    } catch (error) {
      return {
        ok: false,
        error: `${file.path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it and enroll again`,
      };
    }
    const merged = mergeHookGroups(
      existing,
      stellaHookEntries(config),
      config.enrollmentId,
    );
    const text = `${JSON.stringify(merged.settings, null, 2)}\n`;
    return {
      ok: true,
      file: { ...file, text },
      changed: merged.changed || file.text === undefined,
    };
  }
  const current = file.text ?? "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const base = stripStellaTomlBlocks(current, config.enrollmentId);
  const conflicts = stellaTomlConflicts(base);
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `${file.path} already defines ${conflicts.map((e) => `hooks.${e}`).join(", ")} as a key or a [table], so the [[hooks.<Event>]] tables Tacho appends would be a duplicate key; move those hooks to [[hooks.<Event>]] array tables and enroll again`,
    };
  }
  const separator = base.length === 0 ? "" : eol;
  const text = `${base}${separator}${renderStellaTomlBlock(config, eol)}`;
  return { ok: true, file: { ...file, text }, changed: text !== file.text };
}

/** Remove Tacho's hooks (one enrollment, or any) from the file. */
export function stripStellaHooks(
  file: StellaHooksFile,
  enrollmentId?: string,
): { file: StellaHooksFile; changed: boolean } {
  if (file.text === undefined) return { file, changed: false };
  if (file.format === "json") {
    let existing: unknown;
    try {
      existing = parseJson(file.text);
    } catch {
      return { file, changed: false };
    }
    const stripped = stripHookGroups(existing, enrollmentId);
    if (!stripped.changed) return { file, changed: false };
    return {
      file: {
        ...file,
        text: `${JSON.stringify(stripped.settings, null, 2)}\n`,
      },
      changed: true,
    };
  }
  const text = stripStellaTomlBlocks(file.text, enrollmentId);
  return { file: { ...file, text }, changed: text !== file.text };
}

export type StellaHookPresence = HookGroupPresence<StellaHookEventName>;

/** Which of Tacho's Stella hooks are installed for this enrollment. */
export function stellaHookPresence(
  file: StellaHooksFile,
  enrollmentId: string,
): StellaHookPresence {
  if (file.format === "json") {
    let existing: unknown;
    try {
      existing = parseJson(file.text);
    } catch {
      existing = {};
    }
    return hookGroupPresence(existing, STELLA_HOOK_EVENTS, enrollmentId);
  }
  const events = tomlBlockEvents(file.text ?? "", enrollmentId);
  const present = STELLA_HOOK_EVENTS.filter((event) => events.has(event));
  const missing = STELLA_HOOK_EVENTS.filter((event) => !events.has(event));
  return { complete: missing.length === 0, present, missing };
}
