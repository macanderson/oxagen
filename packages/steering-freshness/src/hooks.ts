/**
 * hooks.ts — installing the gate into whichever agent the team already runs.
 *
 * ## Why an installer exists at all
 *
 * The gate is only worth building if it is actually in front of a prompt,
 * and the step people skip is the one where they hand-edit a JSON file they
 * have never opened. So `oxagen steering hooks install` writes it, and
 * writing it is the part that has to be careful: these are files the
 * developer owns and that hold other people's hooks.
 *
 * Three rules hold for every harness below.
 *
 * 1. **Never clobber.** The file is read, the Oxagen entry is replaced by
 *    marker match, and everything else is written back untouched. A config
 *    that cannot be parsed is left alone and reported, because a
 *    half-understood rewrite of someone's hook config is worse than not
 *    installing.
 * 2. **Idempotent.** Installing twice leaves one entry. The marker is the
 *    command string, not a position, so a developer who reorders their hooks
 *    keeps their order.
 * 3. **Uninstallable.** Anything this writes, `remove` takes back out,
 *    including the file itself when nothing else is left in it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The substring that identifies an entry as this feature's. */
export const HOOK_MARKER = "oxagen steering gate";

/**
 * Harnesses this can install into. Cursor and Stella joined Claude Code and
 * Codex here (ADR-101: no harness-facing export is done until each of the
 * four wrapped harnesses can load it, or a PR names the one that cannot and
 * why); every entry point that iterates `INSTALLABLE` — `hooks install
 * --harness all`, `status`, `remove` — picks the new two up for free.
 */
export const INSTALLABLE = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
] as const;
export type InstallableHarness = (typeof INSTALLABLE)[number];

export interface HookIo {
  read: typeof readFile;
  write: typeof writeFile;
  mkdirp: (path: string) => Promise<unknown>;
}

const defaultIo: HookIo = {
  read: readFile,
  write: writeFile,
  mkdirp: (path) => mkdir(path, { recursive: true }),
};

export interface InstallResult {
  harness: InstallableHarness;
  path: string;
  /** "installed" on a first write, "updated" when an entry was replaced. */
  outcome: "installed" | "updated" | "removed" | "absent" | "refused";
  message: string;
}

/** The command a hook runs. `--harness` picks the renderer at run time. */
export function hookCommand(harness: InstallableHarness): string {
  return `oxagen steering gate --harness ${harness}`;
}

/**
 * Where each harness reads its hook config.
 *
 * None of the four are symmetric, and writing them as if they were left an
 * installer reporting success over a file the harness never opens — the
 * gate inactive for every prompt, on a harness the command advertises.
 *
 *   - Claude Code reads `<project>/.claude/settings.json`, a project-scoped
 *     file, so the hook lands beside the repository it governs.
 *   - Codex has no project-scoped hook file. It reads `$CODEX_HOME/hooks.json`
 *     (`~/.codex/hooks.json` by default) and nothing else — the same path
 *     `packages/tacho/src/host/paths.ts` resolves for its own Codex writer,
 *     verified there against developers.openai.com/codex/hooks.
 *   - Cursor reads the user file `~/.cursor/hooks.json` (no project scope,
 *     no environment override) — the same path `packages/tacho/src/host/
 *     paths.ts` resolves for its own Cursor writer, verified there against
 *     cursor.com/docs/agent/hooks.
 *   - Stella reads user-scope hooks from `$STELLA_HOME/stella.toml`
 *     (`~/.stella` by default), or from the legacy `$STELLA_HOME/
 *     settings.json` when no TOML exists — `packages/tacho/src/host/
 *     stella-writer.ts` has the citation. This function answers the TOML
 *     path, Stella's default target when neither file exists yet; the
 *     install/remove/status paths below choose the legacy JSON file
 *     instead when only it is on disk.
 *
 * `env` and `home` are parameters so a test can pin both without touching the
 * developer's real home directory.
 */
export function hookConfigPath(
  projectRoot: string,
  harness: InstallableHarness,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  switch (harness) {
    case "claude-code":
      return join(projectRoot, ".claude", "settings.json");
    case "codex":
      return join(env["CODEX_HOME"] ?? join(home, ".codex"), "hooks.json");
    case "cursor":
      return join(home, ".cursor", "hooks.json");
    case "stella":
      return join(env["STELLA_HOME"] ?? join(home, ".stella"), "stella.toml");
  }
}

/** Stella's legacy JSON hook file, beside {@link hookConfigPath}'s TOML answer. */
function stellaJsonPath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return join(env["STELLA_HOME"] ?? join(home, ".stella"), "settings.json");
}

interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookGroup {
  hooks?: HookCommandEntry[];
  [k: string]: unknown;
}

interface HookConfig {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/**
 * The hook's own timeout, in seconds.
 *
 * It has to be longer than the git fetch it may perform and shorter than a
 * developer's patience. A hook that times out is treated by both harnesses
 * as a failure, which does not block the prompt, so the cost of being wrong
 * here is a missed warning rather than a wedged agent.
 */
export const HOOK_TIMEOUT_SECONDS = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse a hook config, or return null for one this code cannot edit safely.
 *
 * Valid JSON is not enough. A file whose `hooks` is a string, or whose
 * `hooks.UserPromptSubmit` is an object rather than an array, was accepted
 * by the cast and then hit array methods in the install, remove, and status
 * paths, which threw instead of refusing and leaving the file alone. Every
 * level the writers touch is checked here: `hooks` is an object, each event
 * is an array of objects, and each group's `hooks` (when present) is an
 * array of objects.
 */
function readConfig(text: string): HookConfig | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed["hooks"] === undefined) return parsed as HookConfig;
    const hooks = parsed["hooks"];
    if (!isRecord(hooks)) return null;
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) return null;
      for (const group of groups) {
        if (!isRecord(group)) return null;
        if (group["hooks"] === undefined) continue;
        if (!Array.isArray(group["hooks"])) return null;
        if (!group["hooks"].every(isRecord)) return null;
      }
    }
    return parsed as HookConfig;
  } catch {
    return null;
  }
}

/** Strip every group whose command carries the marker. Returns what is left. */
function withoutOxagen(groups: HookGroup[]): HookGroup[] {
  const kept: HookGroup[] = [];
  for (const group of groups) {
    const hooks = (group.hooks ?? []).filter(
      (h) => !String(h.command ?? "").includes(HOOK_MARKER),
    );
    // A group that held nothing but the Oxagen entry goes with it, rather
    // than being left behind as an empty object the next reader has to
    // wonder about.
    if (hooks.length === 0 && (group.hooks ?? []).length > 0) continue;
    kept.push(
      hooks.length === (group.hooks ?? []).length ? group : { ...group, hooks },
    );
  }
  return kept;
}

async function loadConfig(
  path: string,
  io: HookIo,
): Promise<{ config: HookConfig; existed: boolean } | "unparseable"> {
  let text: string;
  try {
    text = String(await io.read(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { config: {}, existed: false };
    }
    return "unparseable";
  }
  if (text.trim() === "") return { config: {}, existed: true };
  const config = readConfig(text);
  return config === null ? "unparseable" : { config, existed: true };
}

/**
 * Add, or refresh, the `UserPromptSubmit` entry for Claude Code or Codex —
 * the two harnesses that share the `{ hooks: { <Event>: [{ hooks: [...] }] } }`
 * group shape.
 */
async function installGroupHook(
  path: string,
  harness: "claude-code" | "codex",
  io: HookIo,
): Promise<InstallResult> {
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness,
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone. Fix it, then run this again.`,
    };
  }

  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks.UserPromptSubmit ?? [];
  const had = existing.some((g) =>
    (g.hooks ?? []).some((h) => String(h.command ?? "").includes(HOOK_MARKER)),
  );
  hooks.UserPromptSubmit = [
    ...withoutOxagen(existing),
    {
      hooks: [
        {
          type: "command",
          command: hookCommand(harness),
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];

  await io.mkdirp(dirname(path));
  await io.write(
    path,
    `${JSON.stringify({ ...config, hooks }, null, 2)}\n`,
    "utf8",
  );
  return {
    harness,
    path,
    outcome: had ? "updated" : "installed",
    message: `${had ? "Updated" : "Installed"} the steering gate in ${path}.`,
  };
}

/** Take the Claude Code / Codex entry back out. */
async function removeGroupHook(
  path: string,
  harness: "claude-code" | "codex",
  io: HookIo,
): Promise<InstallResult> {
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness,
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone.`,
    };
  }
  if (!loaded.existed) {
    return {
      harness,
      path,
      outcome: "absent",
      message: `No ${harness} hook config at ${path}.`,
    };
  }

  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks.UserPromptSubmit ?? [];
  const kept = withoutOxagen(existing);
  if (kept.length === existing.length) {
    return {
      harness,
      path,
      outcome: "absent",
      message: `The steering gate is not installed in ${path}.`,
    };
  }
  if (kept.length === 0) delete hooks.UserPromptSubmit;
  else hooks.UserPromptSubmit = kept;

  const next: HookConfig = { ...config };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;

  await io.write(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    harness,
    path,
    outcome: "removed",
    message: `Removed the steering gate from ${path}.`,
  };
}

/** Is the Claude Code / Codex entry installed right now? */
async function groupHookInstalled(path: string, io: HookIo): Promise<boolean> {
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") return false;
  return (loaded.config.hooks?.UserPromptSubmit ?? []).some((g) =>
    (g.hooks ?? []).some((h) => String(h.command ?? "").includes(HOOK_MARKER)),
  );
}

// ---------------------------------------------------------------------------
// Cursor — `~/.cursor/hooks.json`, a flat array per event, `version: 1`.
//
// cursor.com/docs/agent/hooks: `beforeSubmitPrompt` fires before the prompt
// reaches the model and answers `{"continue": bool}` — see render.ts's
// `renderCursorPrompt`. `packages/tacho/src/host/cursor-writer.ts` verified
// the same shape for Tacho's own telemetry hooks.
// ---------------------------------------------------------------------------

interface CursorHookEntry {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface CursorHooksDoc {
  version?: unknown;
  hooks?: Record<string, CursorHookEntry[]>;
  [k: string]: unknown;
}

const CURSOR_EVENT = "beforeSubmitPrompt";

function readCursorConfig(text: string): CursorHooksDoc | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed["hooks"] === undefined) return parsed as CursorHooksDoc;
    const hooks = parsed["hooks"];
    if (!isRecord(hooks)) return null;
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries) || !entries.every(isRecord)) return null;
    }
    return parsed as CursorHooksDoc;
  } catch {
    return null;
  }
}

async function loadCursorConfig(
  path: string,
  io: HookIo,
): Promise<{ config: CursorHooksDoc; existed: boolean } | "unparseable"> {
  let text: string;
  try {
    text = String(await io.read(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { config: {}, existed: false };
    }
    return "unparseable";
  }
  if (text.trim() === "") return { config: {}, existed: true };
  const config = readCursorConfig(text);
  return config === null ? "unparseable" : { config, existed: true };
}

function withoutOxagenCursor(entries: CursorHookEntry[]): CursorHookEntry[] {
  return entries.filter((e) => !String(e.command ?? "").includes(HOOK_MARKER));
}

async function installCursorHook(
  path: string,
  io: HookIo,
): Promise<InstallResult> {
  const loaded = await loadCursorConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness: "cursor",
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone. Fix it, then run this again.`,
    };
  }
  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks[CURSOR_EVENT] ?? [];
  const had = existing.some((e) =>
    String(e.command ?? "").includes(HOOK_MARKER),
  );
  hooks[CURSOR_EVENT] = [
    ...withoutOxagenCursor(existing),
    {
      type: "command",
      command: hookCommand("cursor"),
      timeout: HOOK_TIMEOUT_SECONDS,
    },
  ];
  const next: CursorHooksDoc = { ...config, hooks };
  // `version: 1` is required at the top level; set it only when the file
  // had none, the same rule `mergeCursorHooks` in the Tacho writer applies.
  if (next.version === undefined) next.version = 1;

  await io.mkdirp(dirname(path));
  await io.write(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    harness: "cursor",
    path,
    outcome: had ? "updated" : "installed",
    message: `${had ? "Updated" : "Installed"} the steering gate in ${path}.`,
  };
}

async function removeCursorHook(
  path: string,
  io: HookIo,
): Promise<InstallResult> {
  const loaded = await loadCursorConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness: "cursor",
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone.`,
    };
  }
  if (!loaded.existed) {
    return {
      harness: "cursor",
      path,
      outcome: "absent",
      message: `No cursor hook config at ${path}.`,
    };
  }
  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks[CURSOR_EVENT] ?? [];
  const kept = withoutOxagenCursor(existing);
  if (kept.length === existing.length) {
    return {
      harness: "cursor",
      path,
      outcome: "absent",
      message: `The steering gate is not installed in ${path}.`,
    };
  }
  if (kept.length === 0) delete hooks[CURSOR_EVENT];
  else hooks[CURSOR_EVENT] = kept;

  const next: CursorHooksDoc = { ...config };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  // `version` stays: the file is Cursor's, and the developer's own hooks (or
  // Tacho's telemetry ones) may still need it. Only drop it alongside
  // `hooks` when nothing but `version` is left, which is what a fresh
  // install of just this gate would have written.
  const remaining = Object.keys(next);
  if (remaining.length === 1 && remaining[0] === "version") delete next.version;

  await io.write(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    harness: "cursor",
    path,
    outcome: "removed",
    message: `Removed the steering gate from ${path}.`,
  };
}

async function cursorHookInstalled(path: string, io: HookIo): Promise<boolean> {
  const loaded = await loadCursorConfig(path, io);
  if (loaded === "unparseable") return false;
  return (loaded.config.hooks?.[CURSOR_EVENT] ?? []).some((e) =>
    String(e.command ?? "").includes(HOOK_MARKER),
  );
}

// ---------------------------------------------------------------------------
// Stella — `stella.toml` (preferred) or the legacy `settings.json`.
//
// `packages/tacho/src/host/stella-writer.ts` is the citation
// (crates/stella-core/src/hooks.rs, verified 2026-09-15): both formats carry
// `hooks.<Event> = [{ hooks: [{ type: "command", command, timeoutMs }] }]`,
// JSON with the ordinary array-of-objects shape, TOML as `[[hooks.<Event>]]`
// array-of-tables. Only `UserPromptSubmit` is written here — the steering
// gate is one hook, not Tacho's whole telemetry set — so the TOML writer
// manages a single marker-delimited block rather than one per event.
// ---------------------------------------------------------------------------

const STELLA_BLOCK_START =
  "# >>> oxagen steering gate (managed by oxagen; do not edit) >>>";
const STELLA_BLOCK_END = "# <<< oxagen steering gate <<<";
/** Stella clamps any larger `timeoutMs`; this is `HOOK_TIMEOUT_SECONDS` in ms. */
const STELLA_HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000;

/**
 * Every managed block, with the one line break the merge put before it — so
 * removing exactly one restores the original bytes, the same property
 * `stella-writer.ts`'s `blockPattern` keeps.
 */
const STELLA_BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)?^${STELLA_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n[\\s\\S]*?^${STELLA_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\r?\\n|$)`,
  "gm",
);

function stripStellaBlock(text: string): string {
  return text.replace(STELLA_BLOCK_PATTERN, "");
}

/**
 * Whether the managed block is present, without the caller having to
 * remember to reset `lastIndex`.
 *
 * `STELLA_BLOCK_PATTERN` carries the `g` flag (required for `.replace` to
 * remove every occurrence), and `RegExp.prototype.test` on a `g` pattern
 * resumes from wherever the PREVIOUS call left `lastIndex` rather than
 * always searching from the start. A caller that used `.test()` and then
 * read `.applied`/`.installed` without resetting it left the object primed
 * to search from partway through the string on the next check — which, on a
 * file holding exactly one block, could make a still-present block read
 * absent and a `remove` silently no-op, or an absent block read present.
 * Every check goes through this wrapper so `lastIndex` is always 0 both
 * before and after.
 */
function stellaBlockPresent(text: string): boolean {
  STELLA_BLOCK_PATTERN.lastIndex = 0;
  const present = STELLA_BLOCK_PATTERN.test(text);
  STELLA_BLOCK_PATTERN.lastIndex = 0;
  return present;
}

function renderStellaBlock(eol: string): string {
  const lines = [
    STELLA_BLOCK_START,
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(hookCommand("stella"))}`,
    `timeoutMs = ${STELLA_HOOK_TIMEOUT_MS}`,
    "",
    STELLA_BLOCK_END,
  ];
  return `${lines.join(eol)}${eol}`;
}

/**
 * Whether the TOML outside our own managed block already defines
 * `hooks.UserPromptSubmit` some other way — a key, an inline table, a
 * standard `[table]`, or a child table no `[[hooks.UserPromptSubmit]]`
 * earlier in the file owns. Appending our array-of-tables would then be a
 * duplicate key Stella's own TOML parser refuses, so an install with a
 * conflict is refused here first rather than writing a file Stella cannot
 * read. A conservative scan: it does not track multi-line strings or
 * bracketed inline tables spanning several lines, so it can flag a false
 * conflict (refusing to write) but never miss a real one silently.
 */
function stellaTomlConflict(strippedText: string): boolean {
  let header = "";
  let inElement = false;
  for (const rawLine of strippedText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const arrayMatch = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    if (arrayMatch) {
      header = (arrayMatch[1] as string).replace(/\s*\.\s*/g, ".");
      if (header === "hooks.UserPromptSubmit") {
        inElement = true;
        continue;
      }
      if (header.startsWith("hooks.UserPromptSubmit.") && !inElement)
        return true;
      inElement = false;
      continue;
    }
    const tableMatch = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (tableMatch) {
      header = (tableMatch[1] as string).replace(/\s*\.\s*/g, ".");
      inElement = false;
      if (
        header === "hooks.UserPromptSubmit" ||
        header.startsWith("hooks.UserPromptSubmit.")
      )
        return true;
      continue;
    }
    if (inElement) continue;
    const keyMatch = /^([^=]+?)\s*=/.exec(line);
    if (!keyMatch) continue;
    const key = (keyMatch[1] as string).trim().replace(/\s*\.\s*/g, ".");
    const full = header.length > 0 ? `${header}.${key}` : key;
    if (
      full === "hooks" ||
      full === "hooks.UserPromptSubmit" ||
      full.startsWith("hooks.UserPromptSubmit.")
    )
      return true;
  }
  return false;
}

interface StellaTarget {
  path: string;
  format: "toml" | "json";
  text: string | undefined;
}

/** `stella.toml` when it exists, else the legacy `settings.json`, else a new TOML. */
async function loadStellaTarget(
  projectRoot: string,
  io: HookIo,
  env: Record<string, string | undefined>,
  home: string,
): Promise<StellaTarget | "unparseable"> {
  const tomlPath = hookConfigPath(projectRoot, "stella", env, home);
  try {
    return {
      path: tomlPath,
      format: "toml",
      text: String(await io.read(tomlPath, "utf8")),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return "unparseable";
  }
  const jsonPath = stellaJsonPath(env, home);
  try {
    return {
      path: jsonPath,
      format: "json",
      text: String(await io.read(jsonPath, "utf8")),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return "unparseable";
  }
  return { path: tomlPath, format: "toml", text: undefined };
}

async function installStellaHook(
  projectRoot: string,
  io: HookIo,
  env: Record<string, string | undefined>,
  home: string,
): Promise<InstallResult> {
  const target = await loadStellaTarget(projectRoot, io, env, home);
  if (target === "unparseable") {
    return {
      harness: "stella",
      path: hookConfigPath(projectRoot, "stella", env, home),
      outcome: "refused",
      message: `Stella's hook config could not be read, so it was left alone.`,
    };
  }
  const { path, format } = target;

  if (format === "json") {
    const config: HookConfig | null =
      target.text === undefined ? {} : readConfig(target.text);
    if (config === null) {
      return {
        harness: "stella",
        path,
        outcome: "refused",
        message: `${path} could not be read as JSON, so it was left alone. Fix it, then run this again.`,
      };
    }
    const hooks = { ...(config.hooks ?? {}) };
    const existing = hooks.UserPromptSubmit ?? [];
    const had = existing.some((g) =>
      (g.hooks ?? []).some((h) =>
        String(h.command ?? "").includes(HOOK_MARKER),
      ),
    );
    hooks.UserPromptSubmit = [
      ...withoutOxagen(existing),
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("stella"),
            timeoutMs: STELLA_HOOK_TIMEOUT_MS,
          },
        ],
      },
    ];
    await io.mkdirp(dirname(path));
    await io.write(
      path,
      `${JSON.stringify({ ...config, hooks }, null, 2)}\n`,
      "utf8",
    );
    return {
      harness: "stella",
      path,
      outcome: had ? "updated" : "installed",
      message: `${had ? "Updated" : "Installed"} the steering gate in ${path}.`,
    };
  }

  const current = target.text ?? "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const had = stellaBlockPresent(current);
  const base = stripStellaBlock(current);
  if (stellaTomlConflict(base)) {
    return {
      harness: "stella",
      path,
      outcome: "refused",
      message: `${path} already defines hooks.UserPromptSubmit as a key or a [table], so the [[hooks.UserPromptSubmit]] tables Oxagen appends would be a duplicate key. Move that hook to a [[hooks.UserPromptSubmit]] array table and run this again.`,
    };
  }
  const separator = base.length === 0 ? "" : eol;
  const next = `${base}${separator}${renderStellaBlock(eol)}`;
  await io.mkdirp(dirname(path));
  await io.write(path, next, "utf8");
  return {
    harness: "stella",
    path,
    outcome: had ? "updated" : "installed",
    message: `${had ? "Updated" : "Installed"} the steering gate in ${path}.`,
  };
}

async function removeStellaHook(
  projectRoot: string,
  io: HookIo,
  env: Record<string, string | undefined>,
  home: string,
): Promise<InstallResult> {
  const target = await loadStellaTarget(projectRoot, io, env, home);
  if (target === "unparseable") {
    return {
      harness: "stella",
      path: hookConfigPath(projectRoot, "stella", env, home),
      outcome: "refused",
      message: `Stella's hook config could not be read, so it was left alone.`,
    };
  }
  const { path, format, text } = target;
  if (text === undefined) {
    return {
      harness: "stella",
      path,
      outcome: "absent",
      message: `No stella hook config at ${path}.`,
    };
  }

  if (format === "json") {
    const config = readConfig(text);
    if (config === null) {
      return {
        harness: "stella",
        path,
        outcome: "refused",
        message: `${path} could not be read as JSON, so it was left alone.`,
      };
    }
    const hooks = { ...(config.hooks ?? {}) };
    const existing = hooks.UserPromptSubmit ?? [];
    const kept = withoutOxagen(existing);
    if (kept.length === existing.length) {
      return {
        harness: "stella",
        path,
        outcome: "absent",
        message: `The steering gate is not installed in ${path}.`,
      };
    }
    if (kept.length === 0) delete hooks.UserPromptSubmit;
    else hooks.UserPromptSubmit = kept;
    const next: HookConfig = { ...config };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    else next.hooks = hooks;
    await io.write(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return {
      harness: "stella",
      path,
      outcome: "removed",
      message: `Removed the steering gate from ${path}.`,
    };
  }

  if (!stellaBlockPresent(text)) {
    return {
      harness: "stella",
      path,
      outcome: "absent",
      message: `The steering gate is not installed in ${path}.`,
    };
  }
  await io.write(path, stripStellaBlock(text), "utf8");
  return {
    harness: "stella",
    path,
    outcome: "removed",
    message: `Removed the steering gate from ${path}.`,
  };
}

async function stellaHookInstalled(
  projectRoot: string,
  io: HookIo,
  env: Record<string, string | undefined>,
  home: string,
): Promise<boolean> {
  const target = await loadStellaTarget(projectRoot, io, env, home);
  if (target === "unparseable" || target.text === undefined) return false;
  if (target.format === "json") {
    const config = readConfig(target.text);
    if (config === null) return false;
    return (config.hooks?.UserPromptSubmit ?? []).some((g) =>
      (g.hooks ?? []).some((h) =>
        String(h.command ?? "").includes(HOOK_MARKER),
      ),
    );
  }
  return stellaBlockPresent(target.text);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Add, or refresh, the steering gate for one harness. */
export async function installHook(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<InstallResult> {
  switch (harness) {
    case "claude-code":
    case "codex":
      return installGroupHook(
        hookConfigPath(projectRoot, harness, env, home),
        harness,
        io,
      );
    case "cursor":
      return installCursorHook(
        hookConfigPath(projectRoot, harness, env, home),
        io,
      );
    case "stella":
      return installStellaHook(projectRoot, io, env, home);
  }
}

/** Take the gate back out for one harness. */
export async function removeHook(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<InstallResult> {
  switch (harness) {
    case "claude-code":
    case "codex":
      return removeGroupHook(
        hookConfigPath(projectRoot, harness, env, home),
        harness,
        io,
      );
    case "cursor":
      return removeCursorHook(
        hookConfigPath(projectRoot, harness, env, home),
        io,
      );
    case "stella":
      return removeStellaHook(projectRoot, io, env, home);
  }
}

/** Is the gate installed for this harness right now? */
export async function hookStatus(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<{ harness: InstallableHarness; path: string; installed: boolean }> {
  const path = hookConfigPath(projectRoot, harness, env, home);
  switch (harness) {
    case "claude-code":
    case "codex":
      return { harness, path, installed: await groupHookInstalled(path, io) };
    case "cursor":
      return { harness, path, installed: await cursorHookInstalled(path, io) };
    case "stella":
      return {
        harness,
        path,
        installed: await stellaHookInstalled(projectRoot, io, env, home),
      };
  }
}
