/**
 * The enrollment contract for the loopback model proxy (story sheet item 10:
 * "enrollment writes the base URL").
 *
 * Three harnesses can be pointed at the proxy, each through the one setting
 * its vendor documents for it, and every login kind rides the same setting:
 *
 *   - Claude Code reads `env.ANTHROPIC_BASE_URL` from `~/.claude/settings.json`
 *     and copies it into its own environment before it builds the API client.
 *     API-key and claude.ai subscription logins build that client the same
 *     way, so one value covers both. Managed settings are applied after user
 *     settings and win, which is why the state below reports a managed value
 *     that shadows ours instead of pretending the write took effect.
 *
 *     The base URL alone breaks Claude Code. Claude Code defers its MCP tool
 *     catalog behind a `ToolSearch` tool, and it turns that off the moment
 *     `ANTHROPIC_BASE_URL` is not a first-party Anthropic host, on the theory
 *     that an unknown proxy may not forward `tool_reference` blocks. With it
 *     off, every request carries the whole catalog. On a machine with a few
 *     hundred MCP tools that is ~500k tokens before the first word of the
 *     prompt, which is over the context window: Claude Code auto-compacts,
 *     the next turn is just as large, and after three rounds it stops the
 *     session with `autocompact_thrashing`. `ENABLE_TOOL_SEARCH=true` is
 *     Claude Code's own override for a proxy that does forward the blocks,
 *     and the loopback proxy forwards every request byte and header as it
 *     received them, so apply writes it beside the base URL and restore
 *     takes it out again. A value the user already set that enables the
 *     search (`true`, `auto`, `auto:N`) is left alone.
 *   - Codex reads the top-level `openai_base_url` key of `~/.codex/config.toml`
 *     as the base URL of its built-in `openai` provider. That provider cannot
 *     be redefined under `model_providers`, and the key applies to both the
 *     API-key login and the ChatGPT login. Our URL ends in
 *     `/backend-api/codex`, which is the suffix Codex requires before it keeps
 *     using its backend-only routes. The proxy then picks the vendor host from
 *     the credential the request carries.
 *   - Stella reads `providers.anthropic.base_url` from its user-scope config,
 *     `$STELLA_HOME/stella.toml` (`~/.stella` by default), or from the legacy
 *     `settings.json` beside it when no TOML exists. A TOML file wins whole,
 *     so the key goes into whichever file Stella is reading, and a new file is
 *     always a TOML one. Our URL is `/stella/anthropic`, a prefix of its own,
 *     because Stella sends no session header and the proxy would otherwise
 *     file its calls under a live Claude Code session. Only the Anthropic
 *     provider is routed: the proxy has no upstream for Stella's
 *     OpenAI-compatible providers (OpenRouter, Z.ai and the rest).
 *
 *     Stella differs in one rule. A `base_url` the user already set for
 *     Anthropic is theirs, and Stella has no second setting the proxy could
 *     learn its upstream from, so apply leaves it in place and reports the
 *     harness as not routed rather than displacing it. The same holds when
 *     the table is defined in a shape a line edit cannot extend safely.
 *
 * The contract is the MCP config writer's: idempotent, a colliding value is
 * displaced and remembered, and restore removes only what apply added. What
 * is remembered lives in a sidecar beside the file rather than in `host.json`,
 * so this module needs nothing but a home directory and a port.
 *
 * Restore is byte-exact when it can be. The sidecar keeps the file as it was
 * before the first apply and the digest of the file as apply left it. If the
 * file still has that digest, nobody else touched it, and the original bytes
 * go back (or the file is removed, when apply created it). If somebody did
 * edit it, the original is stale, so restore edits the current file instead:
 * it takes out our value, puts back the displaced one, and leaves every other
 * change alone.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  findStellaBaseUrl,
  joinLines,
  splitLines,
  stellaBaseUrlLine,
  stellaTableIsEmpty,
  type TomlLine,
  tomlStringValue,
} from "./model-base-url-toml";
import type { ModelRoutedHarness } from "../wire";

/** The harnesses the route table gives a base URL. */
export type ModelBaseUrlHarness = ModelRoutedHarness;

export interface ModelBaseUrlOptions {
  /** The user's home directory; `~/.claude` and `~/.codex` are read under it. */
  home: string;
  /** Stella's home, `$STELLA_HOME`; `~/.stella` when absent. */
  stellaHome?: string;
  /** The loopback port the daemon's model proxy listens on. */
  port: number;
  harnesses: ModelBaseUrlHarness[];
}

export interface ModelBaseUrlHarnessState {
  harness: ModelBaseUrlHarness;
  /** The harness config file this contract reads and writes. */
  file: string;
  /** The key written, as a person would name it. */
  key: string;
  /** The value apply writes for this port. */
  expected: string;
  /** What the file holds now; null when the key or the file is absent. */
  current: string | null;
  /** The value apply displaced, kept until restore; null when there was none. */
  previous: string | null;
  /** Whether the current value points at the proxy. */
  ours: boolean;
  /** The sidecar that remembers what apply displaced. */
  backup: string;
  /** Whether this call changed the file. */
  changed: boolean;
  /**
   * A managed settings file that sets the same key. Managed settings win over
   * user settings, so when this is set the harness does not use our value.
   */
  shadowedBy?: { file: string; value: string };
  /**
   * Claude Code only: what `env.ENABLE_TOOL_SEARCH` holds now, and whether
   * that value keeps tool search on behind the proxy. `false` with `ours`
   * true means the base URL is set but every request carries the whole
   * tool catalog, which is the shape that thrashed autocompact.
   */
  toolSearch?: { current: string | null; enabled: boolean };
  /**
   * Why apply left the file as it was and the harness is not routed: a value
   * the user set, or a table shape a line edit cannot extend. Stella only.
   */
  leftAlone?: string;
}

export interface ModelBaseUrlState {
  harnesses: ModelBaseUrlHarnessState[];
}

const SIDECAR_SCHEMA = "oxagen.model-base-url.v1";
const CLAUDE_KEY = "ANTHROPIC_BASE_URL";
/** Claude Code's override that keeps tool search on behind a non-Anthropic host. */
export const CLAUDE_TOOL_SEARCH_KEY = "ENABLE_TOOL_SEARCH";
const CLAUDE_TOOL_SEARCH_VALUE = "true";
const CODEX_KEY = "openai_base_url";
const STELLA_KEY = "providers.anthropic.base_url";
/** The first line of Tacho's managed hooks block in `stella.toml`. */
const STELLA_BLOCK_MARKER = /^# >>> tacho enrollment /;

/**
 * Whether a `ENABLE_TOOL_SEARCH` value keeps the search on. Claude Code reads
 * `true`, `auto` and `auto:N`; anything else, and an absent key, turns it off
 * once the base URL is not an Anthropic host.
 */
export function claudeToolSearchEnabled(
  value: string | null | undefined,
): boolean {
  return typeof value === "string" && /^(true|auto(:\d+)?)$/i.test(value);
}

/** The base URL each harness is given for a port. */
export function modelBaseUrlFor(
  harness: ModelBaseUrlHarness,
  port: number,
): string {
  if (harness === "claude-code") return `http://127.0.0.1:${port}/anthropic`;
  if (harness === "stella") return `http://127.0.0.1:${port}/stella/anthropic`;
  return `http://127.0.0.1:${port}/backend-api/codex`;
}

const OURS: Record<ModelBaseUrlHarness, RegExp> = {
  "claude-code": /^http:\/\/127\.0\.0\.1:\d{2,5}\/anthropic$/,
  codex: /^http:\/\/127\.0\.0\.1:\d{2,5}\/backend-api\/codex$/,
  stella: /^http:\/\/127\.0\.0\.1:\d{2,5}\/stella\/anthropic$/,
};

/** Whether a value is one this contract writes, for any port. */
export function isModelProxyBaseUrl(
  harness: ModelBaseUrlHarness,
  value: string | null | undefined,
): boolean {
  return typeof value === "string" && OURS[harness].test(value);
}

/** Where a harness's files live: the home directory, and Stella's own. */
export interface ModelBaseUrlHomes {
  home: string;
  stellaHome?: string;
}

/**
 * The file this contract edits for a harness. For Stella it is the file
 * Stella reads: `stella.toml` when it exists, the legacy `settings.json` when
 * only that exists, and a new `stella.toml` when neither does. Writing a new
 * TOML beside a JSON would make Stella ignore the JSON, hooks and all.
 */
export function modelBaseUrlFile(
  harness: ModelBaseUrlHarness,
  homes: ModelBaseUrlHomes,
): string {
  if (harness === "claude-code")
    return join(homes.home, ".claude", "settings.json");
  if (harness === "codex") return join(homes.home, ".codex", "config.toml");
  const stellaHome = homes.stellaHome ?? join(homes.home, ".stella");
  const toml = join(stellaHome, "stella.toml");
  const json = join(stellaHome, "settings.json");
  return !existsSync(toml) && existsSync(json) ? json : toml;
}

const fileFor = modelBaseUrlFile;

function keyLabel(harness: ModelBaseUrlHarness): string {
  if (harness === "claude-code") return `env.${CLAUDE_KEY}`;
  return harness === "stella" ? STELLA_KEY : CODEX_KEY;
}

function isJsonFile(file: string): boolean {
  return file.endsWith(".json");
}

function sidecarFor(file: string): string {
  return join(dirname(file), `.${basename(file)}.oxagen-model-base-url.json`);
}

/** The receipt survives a reassign that drops this harness from host.json. */
export function modelBaseUrlBackupPath(
  harness: ModelBaseUrlHarness,
  home: string,
  stellaHome?: string,
): string {
  return sidecarFor(fileFor(harness, homesOf(home, stellaHome)));
}

function homesOf(
  home: string,
  stellaHome: string | undefined,
): ModelBaseUrlHomes {
  return stellaHome !== undefined ? { home, stellaHome } : { home };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Sidecar {
  schema: typeof SIDECAR_SCHEMA;
  harness: ModelBaseUrlHarness;
  /** Whether the file existed before the first apply. */
  existed: boolean;
  /** The file before the first apply, base64; empty when it did not exist. */
  original_base64: string;
  /** The digest of the file as the latest apply left it. */
  written_sha256: string;
  /** The displaced value, or null when the key was absent. */
  previous: string | null;
  /** Codex only: the exact line that was displaced, comment and all. */
  previous_line: string | null;
  /** Claude Code only: whether apply had to create the `env` object. */
  created_env: boolean;
  /**
   * Stella only: what apply created around the key, so a restore after other
   * edits removes the scaffolding with it. In `stella.toml` that is the
   * `[providers.anthropic]` header; in `settings.json` the `providers` object,
   * the `anthropic` object, or both.
   */
  created_table?: boolean;
  /** Stella only: apply put a blank line before the header it created. */
  created_blank?: boolean;
  created_providers?: boolean;
  created_provider?: boolean;
  /**
   * Claude Code only: the `ENABLE_TOOL_SEARCH` value apply displaced, or null
   * when the key was absent. Absent from the sidecar when apply never wrote
   * the key, either because the user's own value already enabled the search
   * or because the sidecar predates the key, and restore then leaves it be.
   */
  previous_tool_search?: string | null;
}

function readSidecar(path: string): Sidecar | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Sidecar>;
    if (parsed.schema !== SIDECAR_SCHEMA) return undefined;
    if (typeof parsed.written_sha256 !== "string") return undefined;
    return {
      schema: SIDECAR_SCHEMA,
      harness:
        parsed.harness === "codex" || parsed.harness === "stella"
          ? parsed.harness
          : "claude-code",
      existed: parsed.existed === true,
      original_base64:
        typeof parsed.original_base64 === "string"
          ? parsed.original_base64
          : "",
      written_sha256: parsed.written_sha256,
      previous: typeof parsed.previous === "string" ? parsed.previous : null,
      previous_line:
        typeof parsed.previous_line === "string" ? parsed.previous_line : null,
      created_env: parsed.created_env === true,
      ...(parsed.created_table === true ? { created_table: true } : {}),
      ...(parsed.created_blank === true ? { created_blank: true } : {}),
      ...(parsed.created_providers === true ? { created_providers: true } : {}),
      ...(parsed.created_provider === true ? { created_provider: true } : {}),
      ...("previous_tool_search" in parsed
        ? {
            previous_tool_search:
              typeof parsed.previous_tool_search === "string"
                ? parsed.previous_tool_search
                : null,
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Write a file through a sibling temp file and a rename, keeping the mode and
 * the owner the file already had. A new file is private to its owner.
 */
function writeAtomicPreserving(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  let owner: { uid: number; gid: number } | undefined;
  try {
    const stat = statSync(path);
    mode = stat.mode & 0o7777;
    owner = { uid: stat.uid, gid: stat.gid };
  } catch {
    // A file that does not exist yet has no mode or owner to keep.
  }
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // `open` applies the umask. The file must end with the mode it had.
    chmodSync(tmp, mode);
    if (owner !== undefined) {
      try {
        chownSync(tmp, owner.uid, owner.gid);
      } catch {
        // Only root may give a file away. The same owner needs no change.
      }
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw error;
  }
}

function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Claude Code: `env.ANTHROPIC_BASE_URL` in a JSON document
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function parseSettings(text: string | undefined, file: string): JsonObject {
  if (text === undefined || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON, so it was left untouched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} is not a JSON object, so it was left untouched`);
  return parsed as JsonObject;
}

function envOf(settings: JsonObject): JsonObject | undefined {
  const env = settings["env"];
  return typeof env === "object" && env !== null && !Array.isArray(env)
    ? (env as JsonObject)
    : undefined;
}

function claudeValue(settings: JsonObject): string | null {
  const value = envOf(settings)?.[CLAUDE_KEY];
  return typeof value === "string" ? value : null;
}

function claudeToolSearchValue(settings: JsonObject): string | null {
  const value = envOf(settings)?.[CLAUDE_TOOL_SEARCH_KEY];
  return typeof value === "string" ? value : null;
}

/** Serialize the way the file was written: its indent and its final newline. */
function serializeLike(text: string | undefined, settings: JsonObject): string {
  const indent = /\n([ \t]+)"/.exec(text ?? "")?.[1] ?? "  ";
  const eol = text !== undefined && text.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(settings, null, indent).replace(/\n/g, eol);
  const final = text === undefined || /\r?\n$/.test(text) ? eol : "";
  return `${body}${final}`;
}

// ---------------------------------------------------------------------------
// Codex: a top-level `openai_base_url` key in a TOML document, edited as text
// so every comment, blank line and key order survives.
// ---------------------------------------------------------------------------

const TOML_KEY_LINE =
  /^\s*(?:openai_base_url|"openai_base_url"|'openai_base_url')\s*=\s*(.*)$/;

/**
 * The index of the top-level `openai_base_url` line, or -1. Top level ends at
 * the first table header, and a line inside a multi-line string is not a key.
 */
function findTomlKey(lines: readonly TomlLine[]): number {
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (fence !== undefined) {
      if (text.includes(fence)) fence = undefined;
      continue;
    }
    if (/^\s*\[/.test(text)) return -1;
    if (TOML_KEY_LINE.test(text)) return index;
    const opened = /=\s*("""|''')/.exec(text);
    if (opened !== null) {
      const marker = opened[1] as string;
      const after = text.slice(opened.index + opened[0].length);
      if (!after.includes(marker)) fence = marker;
    }
  }
  return -1;
}

function tomlValueAt(lines: readonly TomlLine[], index: number): string | null {
  if (index < 0) return null;
  const rest = TOML_KEY_LINE.exec(lines[index]?.text ?? "")?.[1] ?? "";
  return tomlStringValue(rest);
}

function tomlLineFor(url: string): string {
  return `${CODEX_KEY} = ${JSON.stringify(url)}`;
}

// ---------------------------------------------------------------------------
// Stella: `providers.anthropic.base_url`, in `stella.toml` as text or in the
// legacy `settings.json` as a document.
// ---------------------------------------------------------------------------

function objectAt(
  parent: JsonObject | undefined,
  key: string,
): JsonObject | undefined {
  const value = parent?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stellaJsonValue(settings: JsonObject): string | null {
  const value = objectAt(objectAt(settings, "providers"), "anthropic")?.[
    "base_url"
  ];
  return typeof value === "string" ? value : null;
}

/** Stella's value, whichever file carries it; null when the key is absent. */
function stellaValue(file: string, text: string): string | null {
  if (isJsonFile(file)) return stellaJsonValue(parseSettings(text, file));
  const found = findStellaBaseUrl(splitLines(text));
  return found.kind === "table" ? found.value : null;
}

// ---------------------------------------------------------------------------
// Managed settings
// ---------------------------------------------------------------------------

/** Where Claude Code reads managed settings, which win over user settings. */
export function claudeManagedSettingsPath(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin")
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32")
    return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Where Stella reads managed settings, which are merged after user settings
 * and win. `STELLA_MANAGED_SETTINGS` names the file outright; otherwise the
 * TOML is read when it exists and the JSON when only that does.
 */
export function stellaManagedSettingsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const named = env["STELLA_MANAGED_SETTINGS"];
  if (named !== undefined && named.length > 0) return named;
  const dir =
    platform === "darwin"
      ? "/Library/Application Support/stella"
      : "/etc/stella";
  const toml = join(dir, "stella.toml");
  const json = join(dir, "settings.json");
  return !existsSync(toml) && existsSync(json) ? json : toml;
}

function managedShadow(
  harness: ModelBaseUrlHarness,
  managedFile: string,
  expected: string,
): { file: string; value: string } | undefined {
  try {
    const text = readTextIfExists(managedFile);
    if (text === undefined) return undefined;
    const value =
      harness === "stella"
        ? stellaValue(managedFile, text)
        : claudeValue(parseSettings(text, managedFile));
    return value !== null && value !== expected
      ? { file: managedFile, value }
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

export interface ModelBaseUrlInternals {
  /** Overrides the managed settings path; tests point it at a scratch file. */
  managedSettingsFile?: string;
  /** The same for Stella's managed settings. */
  stellaManagedSettingsFile?: string;
}

function currentValue(
  harness: ModelBaseUrlHarness,
  file: string,
  text: string | undefined,
): string | null {
  if (text === undefined) return null;
  if (harness === "claude-code") return claudeValue(parseSettings(text, file));
  if (harness === "stella") return stellaValue(file, text);
  const lines = splitLines(text);
  return tomlValueAt(lines, findTomlKey(lines));
}

/** A dropped harness with no receipt can still point at the removed gateway. */
export function hasOrphanedModelBaseUrl(
  harness: ModelBaseUrlHarness,
  home: string,
  stellaHome?: string,
): boolean {
  const file = fileFor(harness, homesOf(home, stellaHome));
  const text = readTextIfExists(file);
  try {
    return isModelProxyBaseUrl(harness, currentValue(harness, file, text));
  } catch (error) {
    // Unrelated malformed files were never ours to repair. A visible proxy
    // URL makes the malformed document part of cleanup and keeps it blocked.
    if (text?.includes("http://127.0.0.1:")) throw error;
    return false;
  }
}

/** Why Stella's file was left alone, or undefined when apply may edit it. */
function stellaLeftAlone(
  file: string,
  text: string | undefined,
): string | undefined {
  if (text === undefined) return undefined;
  if (isJsonFile(file)) {
    const settings = parseSettings(text, file);
    const providers = settings["providers"];
    const provider = objectAt(settings, "providers")?.["anthropic"];
    if (
      (providers !== undefined &&
        objectAt(settings, "providers") === undefined) ||
      (provider !== undefined &&
        objectAt(objectAt(settings, "providers"), "anthropic") === undefined)
    )
      return `${file} defines providers.anthropic as something other than an object, so it was left untouched and Stella's Anthropic calls are not routed through Oxagen`;
    const value = objectAt(objectAt(settings, "providers"), "anthropic")?.[
      "base_url"
    ];
    if (
      value !== undefined &&
      !isModelProxyBaseUrl("stella", typeof value === "string" ? value : null)
    )
      return `${file} already sets ${STELLA_KEY}, so it was left in place and Stella's Anthropic calls are not routed through Oxagen`;
    return undefined;
  }
  const found = findStellaBaseUrl(splitLines(text));
  if (found.kind === "conflict")
    return `${file} defines [providers.anthropic] in a shape a line edit cannot extend safely (a dotted key or an inline table), so it was left untouched and Stella's Anthropic calls are not routed through Oxagen`;
  if (
    found.kind === "table" &&
    found.key >= 0 &&
    !isModelProxyBaseUrl("stella", found.value)
  )
    return `${file} already sets ${STELLA_KEY}, so it was left in place and Stella's Anthropic calls are not routed through Oxagen`;
  return undefined;
}

interface StellaPlan {
  next: string;
  current: string | null;
  createdTable: boolean;
  createdBlank: boolean;
  createdProviders: boolean;
  createdProvider: boolean;
}

/** The file with our URL in it. Call only once `stellaLeftAlone` is clear. */
function planStella(
  file: string,
  text: string | undefined,
  url: string,
): StellaPlan {
  if (isJsonFile(file)) {
    const settings = parseSettings(text, file);
    const providers = objectAt(settings, "providers");
    const provider = objectAt(providers, "anthropic");
    const current = stellaJsonValue(settings);
    settings["providers"] = {
      ...(providers ?? {}),
      anthropic: { ...(provider ?? {}), base_url: url },
    };
    return {
      next: serializeLike(text, settings),
      current,
      createdTable: false,
      createdBlank: false,
      createdProviders: providers === undefined,
      createdProvider: provider === undefined,
    };
  }
  const lines = splitLines(text ?? "");
  const eol = (text ?? "").includes("\r\n") ? "\r\n" : "\n";
  const found = findStellaBaseUrl(lines);
  let current: string | null = null;
  let createdTable = false;
  let createdBlank = false;
  if (found.kind === "table" && found.key >= 0) {
    current = found.value;
    const line = lines[found.key] as TomlLine;
    lines[found.key] = { text: stellaBaseUrlLine(url), eol: line.eol };
  } else if (found.kind === "table") {
    const header = lines[found.header] as TomlLine;
    const after = header.eol === "" ? "" : header.eol;
    if (header.eol === "") header.eol = eol;
    lines.splice(found.header + 1, 0, {
      text: stellaBaseUrlLine(url),
      eol: after,
    });
  } else {
    // A header of its own, always, placed before Tacho's hooks block rather
    // than after it. A bare key after the block would land inside its last
    // `[[hooks.…]]` table, and every enroll strips the block and appends it
    // again at the end, so a table after it would move on each enroll. The
    // strip takes the one line break before the block with it, which is the
    // key line's own, so the bytes come back the same.
    const marker = lines.findIndex((line) =>
      STELLA_BLOCK_MARKER.test(line.text),
    );
    const at = marker >= 0 ? marker : lines.length;
    const before = lines[at - 1];
    const added: TomlLine[] = [];
    if (before !== undefined) {
      if (before.eol === "") before.eol = eol;
      if (before.text.trim().length > 0) {
        added.push({ text: "", eol });
        createdBlank = true;
      }
    }
    added.push({ text: "[providers.anthropic]", eol });
    added.push({ text: stellaBaseUrlLine(url), eol });
    lines.splice(at, 0, ...added);
    createdTable = true;
  }
  return {
    next: joinLines(lines),
    current,
    createdTable,
    createdBlank,
    createdProviders: false,
    createdProvider: false,
  };
}

/** Our value out of Stella's file, and what apply built around it. */
function unplanStella(
  file: string,
  text: string,
  sidecar: Sidecar | undefined,
): string | undefined {
  if (isJsonFile(file)) {
    const settings = parseSettings(text, file);
    const providers = objectAt(settings, "providers");
    const provider = objectAt(providers, "anthropic");
    if (provider === undefined || providers === undefined) return undefined;
    const value = provider["base_url"];
    if (
      !isModelProxyBaseUrl("stella", typeof value === "string" ? value : null)
    )
      return undefined;
    delete provider["base_url"];
    if (
      sidecar?.created_provider === true &&
      Object.keys(provider).length === 0
    )
      delete providers["anthropic"];
    if (
      sidecar?.created_providers === true &&
      Object.keys(providers).length === 0
    )
      delete settings["providers"];
    return serializeLike(text, settings);
  }
  const lines = splitLines(text);
  const found = findStellaBaseUrl(lines);
  if (found.kind !== "table" || found.key < 0) return undefined;
  if (!isModelProxyBaseUrl("stella", found.value)) return undefined;
  lines.splice(found.key, 1);
  if (
    sidecar?.created_table === true &&
    stellaTableIsEmpty(lines, found.header)
  ) {
    lines.splice(found.header, 1);
    // The blank line apply put before the header goes with it.
    const before = lines[found.header - 1];
    if (
      sidecar.created_blank === true &&
      before !== undefined &&
      before.text.trim().length === 0
    )
      lines.splice(found.header - 1, 1);
  }
  return joinLines(lines);
}

function describe(
  harness: ModelBaseUrlHarness,
  options: ModelBaseUrlOptions,
  changed: boolean,
  internals: ModelBaseUrlInternals,
): ModelBaseUrlHarnessState {
  const file = fileFor(harness, options);
  const backup = sidecarFor(file);
  const expected = modelBaseUrlFor(harness, options.port);
  const text = readTextIfExists(file);
  const current = currentValue(harness, file, text);
  const sidecar = readSidecar(backup);
  const shadow =
    harness === "claude-code"
      ? managedShadow(
          harness,
          internals.managedSettingsFile ?? claudeManagedSettingsPath(),
          expected,
        )
      : harness === "stella"
        ? managedShadow(
            harness,
            internals.stellaManagedSettingsFile ?? stellaManagedSettingsPath(),
            expected,
          )
        : undefined;
  const leftAlone =
    harness === "stella" ? stellaLeftAlone(file, text) : undefined;
  const toolSearch =
    harness === "claude-code"
      ? claudeToolSearchValue(
          text === undefined ? {} : parseSettings(text, file),
        )
      : undefined;
  return {
    harness,
    file,
    key: keyLabel(harness),
    expected,
    current,
    previous: sidecar?.previous ?? null,
    ours: isModelProxyBaseUrl(harness, current),
    backup,
    changed,
    ...(shadow !== undefined ? { shadowedBy: shadow } : {}),
    ...(leftAlone !== undefined ? { leftAlone } : {}),
    ...(harness === "claude-code"
      ? {
          toolSearch: {
            current: toolSearch ?? null,
            enabled: claudeToolSearchEnabled(toolSearch),
          },
        }
      : {}),
  };
}

function applyOne(
  harness: ModelBaseUrlHarness,
  options: ModelBaseUrlOptions,
): boolean {
  const file = fileFor(harness, options);
  const backup = sidecarFor(file);
  const url = modelBaseUrlFor(harness, options.port);
  const text = readTextIfExists(file);
  const existing = readSidecar(backup);
  let next: string;
  let previous: string | null = null;
  let previousLine: string | null = null;
  let createdEnv = false;
  let stellaCreated: Pick<
    Sidecar,
    "created_table" | "created_blank" | "created_providers" | "created_provider"
  > = {};
  // Set only when this apply writes `ENABLE_TOOL_SEARCH`; a value the user
  // already had that enables the search is not ours to displace or restore.
  let previousToolSearch: string | null | undefined;
  // Our value with no sidecar: somebody wrote it by hand, or the sidecar was
  // lost. The file before Oxagen is unknowable then, so restore must never
  // treat this text as an original to put back.
  let orphan = false;

  if (harness === "claude-code") {
    const settings = parseSettings(text, file);
    const current = claudeValue(settings);
    const toolSearch = claudeToolSearchValue(settings);
    // A sidecar from before the tool-search key has the base URL in place and
    // the catalog still inlined, so that host is re-applied rather than
    // reported unchanged.
    const needsToolSearch = !claudeToolSearchEnabled(toolSearch);
    if (current === url && !needsToolSearch && existing !== undefined)
      return false;
    const env = envOf(settings);
    createdEnv = env === undefined;
    orphan = existing === undefined && isModelProxyBaseUrl(harness, current);
    if (current !== null && !isModelProxyBaseUrl(harness, current))
      previous = current;
    if (needsToolSearch) previousToolSearch = toolSearch;
    settings["env"] = {
      ...(env ?? {}),
      [CLAUDE_KEY]: url,
      ...(needsToolSearch
        ? { [CLAUDE_TOOL_SEARCH_KEY]: CLAUDE_TOOL_SEARCH_VALUE }
        : {}),
    };
    next = serializeLike(text, settings);
  } else if (harness === "stella") {
    // A value the user set, or a shape a line edit cannot extend, is left as
    // it is: nothing is written and nothing is remembered.
    if (stellaLeftAlone(file, text) !== undefined) return false;
    const plan = planStella(file, text, url);
    if (plan.current === url && existing !== undefined) return false;
    orphan =
      existing === undefined && isModelProxyBaseUrl(harness, plan.current);
    stellaCreated = {
      ...(plan.createdTable ? { created_table: true } : {}),
      ...(plan.createdBlank ? { created_blank: true } : {}),
      ...(plan.createdProviders ? { created_providers: true } : {}),
      ...(plan.createdProvider ? { created_provider: true } : {}),
    };
    next = plan.next;
  } else {
    const lines = splitLines(text ?? "");
    const index = findTomlKey(lines);
    const current = tomlValueAt(lines, index);
    if (current === url && existing !== undefined) return false;
    orphan = existing === undefined && isModelProxyBaseUrl(harness, current);
    if (index >= 0) {
      const line = lines[index] as TomlLine;
      if (!isModelProxyBaseUrl(harness, current)) {
        previous = current;
        previousLine = line.text;
      }
      lines[index] = { text: tomlLineFor(url), eol: line.eol };
    } else {
      const eol = (text ?? "").includes("\r\n") ? "\r\n" : "\n";
      lines.unshift({ text: tomlLineFor(url), eol });
    }
    next = joinLines(lines);
  }

  // A re-apply (a new port) keeps what the first apply remembered: the
  // original is the file before Oxagen touched it, not before this call.
  const sidecar: Sidecar = existing
    ? {
        ...existing,
        written_sha256: sha256(next),
        // The first apply that wrote the key is the one whose displaced
        // value restore puts back; a later re-apply keeps that record.
        ...(existing.previous_tool_search === undefined &&
        previousToolSearch !== undefined
          ? { previous_tool_search: previousToolSearch }
          : {}),
      }
    : {
        schema: SIDECAR_SCHEMA,
        harness,
        existed: text !== undefined,
        original_base64: orphan
          ? ""
          : // The raw bytes, not the decoded text: restore is byte-exact even
            // for a file that is not clean UTF-8.
            (text === undefined
              ? Buffer.alloc(0)
              : readFileSync(file)
            ).toString("base64"),
        written_sha256: orphan ? "" : sha256(next),
        previous,
        previous_line: previousLine,
        created_env: createdEnv,
        ...stellaCreated,
        ...(previousToolSearch !== undefined
          ? { previous_tool_search: previousToolSearch }
          : {}),
      };
  // The sidecar lands first: a crash between the two writes leaves a backup
  // with nothing to restore, never a displaced value with no record of it.
  writeAtomicPreserving(backup, `${JSON.stringify(sidecar, null, 2)}\n`);
  chmodSync(backup, 0o600);
  writeAtomicPreserving(file, next);
  return true;
}

function restoreOne(
  harness: ModelBaseUrlHarness,
  options: ModelBaseUrlOptions,
): boolean {
  const file = fileFor(harness, options);
  const backup = sidecarFor(file);
  const sidecar = readSidecar(backup);
  const text = readTextIfExists(file);
  const dropSidecar = (): void => {
    if (existsSync(backup)) unlinkSync(backup);
  };
  if (text === undefined) {
    dropSidecar();
    return false;
  }

  // Untouched since apply: the original goes back byte for byte.
  if (sidecar !== undefined && sha256(text) === sidecar.written_sha256) {
    if (sidecar.existed) {
      writeAtomicPreserving(
        file,
        Buffer.from(sidecar.original_base64, "base64"),
      );
    } else {
      unlinkSync(file);
    }
    dropSidecar();
    return true;
  }

  // Edited since apply: take out only our value and keep every other change.
  let next: string | undefined;
  if (harness === "claude-code") {
    const settings = parseSettings(text, file);
    const env = envOf(settings);
    if (env !== undefined) {
      const rest: JsonObject = { ...env };
      let touched = false;
      if (isModelProxyBaseUrl(harness, claudeValue(settings))) {
        if (sidecar?.previous != null) rest[CLAUDE_KEY] = sidecar.previous;
        else delete rest[CLAUDE_KEY];
        touched = true;
      }
      // Only the value apply wrote comes out. A user who changed it since,
      // or set it before Oxagen did, keeps it.
      if (
        sidecar?.previous_tool_search !== undefined &&
        rest[CLAUDE_TOOL_SEARCH_KEY] === CLAUDE_TOOL_SEARCH_VALUE
      ) {
        if (sidecar.previous_tool_search !== null)
          rest[CLAUDE_TOOL_SEARCH_KEY] = sidecar.previous_tool_search;
        else delete rest[CLAUDE_TOOL_SEARCH_KEY];
        touched = true;
      }
      if (touched) {
        if (Object.keys(rest).length === 0 && sidecar?.created_env === true)
          delete settings["env"];
        else settings["env"] = rest;
        next = serializeLike(text, settings);
      }
    }
  } else if (harness === "stella") {
    next = unplanStella(file, text, sidecar);
  } else {
    const lines = splitLines(text);
    const index = findTomlKey(lines);
    if (index >= 0 && isModelProxyBaseUrl(harness, tomlValueAt(lines, index))) {
      const line = lines[index] as TomlLine;
      if (sidecar?.previous_line != null)
        lines[index] = { text: sidecar.previous_line, eol: line.eol };
      else lines.splice(index, 1);
      next = joinLines(lines);
    }
  }
  if (next === undefined || next === text) {
    dropSidecar();
    return false;
  }
  writeAtomicPreserving(file, next);
  // Keep the recovery record until the replacement is durable, so a failed
  // write can be retried with the original displaced value intact.
  dropSidecar();
  return true;
}

function unique(
  harnesses: readonly ModelBaseUrlHarness[],
): ModelBaseUrlHarness[] {
  return [...new Set(harnesses)];
}

/** Point each harness at the proxy. Idempotent; a second call changes nothing. */
export async function applyModelBaseUrls(
  options: ModelBaseUrlOptions,
  internals: ModelBaseUrlInternals = {},
): Promise<ModelBaseUrlState> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new Error(`not a TCP port: ${String(options.port)}`);
  return {
    harnesses: unique(options.harnesses).map((harness) =>
      describe(harness, options, applyOne(harness, options), internals),
    ),
  };
}

/** Put back what apply displaced and remove only what apply added. */
export async function restoreModelBaseUrls(
  options: ModelBaseUrlOptions,
  internals: ModelBaseUrlInternals = {},
): Promise<ModelBaseUrlState> {
  return {
    harnesses: unique(options.harnesses).map((harness) =>
      describe(harness, options, restoreOne(harness, options), internals),
    ),
  };
}

/** What each harness file holds now. Reads only. */
export async function readModelBaseUrlState(
  options: ModelBaseUrlOptions,
  internals: ModelBaseUrlInternals = {},
): Promise<ModelBaseUrlState> {
  return {
    harnesses: unique(options.harnesses).map((harness) =>
      describe(harness, options, false, internals),
    ),
  };
}
