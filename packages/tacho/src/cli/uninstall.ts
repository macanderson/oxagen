/**
 * `oxagen agent uninstall`: take Oxagen off this machine without the desktop
 * app (ADR-230, amendment of 2026-10-02, #4298).
 *
 * macOS runs nothing when an app goes to the Trash, and a Linux package
 * manager runs no code for the files an app made in a person's home
 * directory. So the app's own Uninstall cannot be the only way out. This
 * command runs from the app's per-user copy, which outlives the app, or from
 * any other install of the `oxagen` CLI. It works in three steps:
 *
 *   1. `unenroll --all --purge`: every agent's hooks, service, keys and
 *      record. It stops there when an enrollment is not fully gone, because a
 *      hook that still names the per-user copy fails to spawn once the copy
 *      is deleted.
 *   2. What the app's journal records it wrote: the PATH links (or the
 *      Windows `.cmd` shims), the shell profile block, the fish file, and the
 *      user PATH entry on Windows. Each goes only while it is still what the
 *      app wrote. A link someone pointed elsewhere, or a shim someone edited,
 *      stays.
 *   3. The per-user copies under `<data-local>/oxagen/bin`, the directories
 *      the app's installs created, the Tacho directory, and
 *      `~/.config/oxagen`, which is what the app's own Uninstall removes.
 *
 * The journal is the `journal` list in `~/.config/oxagen/desktop.json`. The
 * app writes it (`apps/desktop/src-tauri/src/cli_install.rs`,
 * `record_journal`), and this module only reads it.
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentIsLive, listAgents } from "../host/agents";
import { writeFileAtomic } from "../host/fs";
import type { CliDeps, CredentialOptions } from "./deps";
import { unenroll } from "./unenroll";

export interface UninstallOptions extends CredentialOptions {
  /** Recorded with each revoke. */
  reason?: string;
}

export interface UninstallResult {
  /** False when something Oxagen wrote is still on the machine. */
  ok: boolean;
  removed: string[];
  /** What is still on the machine, each with the reason. */
  left: string[];
  warnings: string[];
}

/** The kinds of thing the desktop app's journal records. */
const JOURNAL_KINDS = [
  "copy",
  "link",
  "shim",
  "profile",
  "fish",
  "user-path",
] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** One thing a desktop app install wrote, as its journal records it. */
export interface JournalEntry {
  kind: JournalKind;
  /** The file, link, or directory. For `user-path`, the PATH entry. */
  path: string;
  /** A link's target, as the app wrote it. */
  target?: string;
  /** A shim's whole text, as the app wrote it. */
  text?: string;
}

/** What `desktop.json` says the desktop app put on this machine. */
export interface DesktopRecord {
  /** `desktop.json` was there and read as a JSON object. */
  found: boolean;
  /** It carried a `journal` list. An app from before the journal wrote none. */
  journaled: boolean;
  journal: JournalEntry[];
  /** The files and directories an install had to create. */
  created: string[];
  /** The app created `~/.config`. */
  configDirCreated: boolean;
  /** Why `desktop.json` could not be read, when it is there. */
  problem?: string;
}

/** The two lines the app puts around the PATH line it adds to a profile. */
const MARKER_BEGIN = "# >>> oxagen >>>";
const MARKER_END = "# <<< oxagen <<<";

/**
 * Where the desktop app keeps its files: `~/Library/Application Support`
 * on macOS, `$XDG_DATA_HOME` or `~/.local/share` on Linux, and
 * `%LOCALAPPDATA%` on Windows. The app reads the same place
 * (`dirs::data_local_dir`).
 */
export function dataLocalDir(
  home: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32")
    return env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
  const xdg = env["XDG_DATA_HOME"];
  return xdg !== undefined && isAbsolute(xdg)
    ? xdg
    : join(home, ".local", "share");
}

/** The places the desktop app writes, for `deps`'s home and platform. */
export function desktopPlaces(
  deps: Pick<CliDeps, "home" | "env" | "platform">,
): { oxagenDir: string; desktopConfig: string; copies: string } {
  const oxagenDir = join(deps.home, ".config", "oxagen");
  return {
    oxagenDir,
    desktopConfig: join(oxagenDir, "desktop.json"),
    copies: join(
      dataLocalDir(deps.home, deps.env, deps.platform),
      "oxagen",
      "bin",
    ),
  };
}

function isJournalKind(value: unknown): value is JournalKind {
  return (JOURNAL_KINDS as readonly unknown[]).includes(value);
}

/**
 * The journal entries `value` holds. An entry that does not read as one the
 * app writes is dropped: nothing is removed on its say.
 */
function journalEntries(value: unknown): JournalEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: JournalEntry[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { kind, path, target, text } = item as Record<string, unknown>;
    if (!isJournalKind(kind) || typeof path !== "string" || !isAbsolute(path))
      continue;
    if (kind === "link" && typeof target !== "string") continue;
    if (kind === "shim" && typeof text !== "string") continue;
    entries.push({
      kind,
      path,
      ...(typeof target === "string" ? { target } : {}),
      ...(typeof text === "string" ? { text } : {}),
    });
  }
  return entries;
}

/** Read `desktop.json`. A missing or unreadable file reads as no record. */
export function readDesktopRecord(path: string): DesktopRecord {
  const none: DesktopRecord = {
    found: false,
    journaled: false,
    journal: [],
    created: [],
    configDirCreated: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return none;
    return {
      ...none,
      problem: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ...none, problem: `${path} is not a JSON object` };
  const config = parsed as Record<string, unknown>;
  const created = Array.isArray(config["created"])
    ? (config["created"] as unknown[]).filter(
        (item): item is string => typeof item === "string" && isAbsolute(item),
      )
    : [];
  return {
    found: true,
    journaled: Array.isArray(config["journal"]),
    journal: journalEntries(config["journal"]),
    created,
    configDirCreated: config["configDirCreated"] === true,
  };
}

/**
 * Whether a line is the one PATH line the app's block carries: the
 * appending form it writes now, or the prepending form an earlier version
 * wrote.
 */
function isPathExportLine(line: string): boolean {
  return (
    (line.startsWith('export PATH="$PATH:') && line.endsWith('"')) ||
    (line.startsWith('export PATH="') && line.endsWith(':$PATH"'))
  );
}

/**
 * `text` without the blocks the desktop app wrote, and without the one line
 * break the app puts in front of each. A block is exactly a begin marker
 * line, one PATH line, and an end marker line. A begin marker whose end the
 * person deleted, or a block they added lines to, is theirs and stays. Every
 * other byte stays as it was. This is `remove_path_block` in
 * `cli_install.rs`, so a file the app wrote a block into comes back byte for
 * byte.
 */
export function removePathBlocks(text: string): string {
  // Each line: where it starts, the line without its break, and where the
  // next one starts.
  const lines: Array<{ start: number; line: string; end: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    const at = text.indexOf("\n", pos);
    let length: number;
    let lineBreak: number;
    if (at < 0) {
      length = text.length - pos;
      lineBreak = 0;
    } else if (at > pos && text.charAt(at - 1) === "\r") {
      length = at - 1 - pos;
      lineBreak = 2;
    } else {
      length = at - pos;
      lineBreak = 1;
    }
    lines.push({
      start: pos,
      line: text.slice(pos, pos + length),
      end: pos + length + lineBreak,
    });
    pos += length + lineBreak;
  }
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i + 2 < lines.length) {
    const first = lines[i] as (typeof lines)[number];
    const middle = lines[i + 1] as (typeof lines)[number];
    const last = lines[i + 2] as (typeof lines)[number];
    if (
      first.line === MARKER_BEGIN &&
      isPathExportLine(middle.line) &&
      last.line === MARKER_END
    ) {
      const floor = ranges.at(-1)?.[1] ?? 0;
      const before = text.slice(floor, first.start);
      const start = before.endsWith("\r\n")
        ? first.start - 2
        : before.endsWith("\n")
          ? first.start - 1
          : first.start;
      ranges.push([start, last.end]);
      i += 3;
    } else {
      i += 1;
    }
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += text.slice(cursor, start);
    cursor = end;
  }
  return out + text.slice(cursor);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** A file's text, or undefined when it is not there. Throws when it is not UTF-8. */
function readText(path: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** What one step of the uninstall removed, and what it left with why. */
interface Tally {
  removed: string[];
  left: string[];
}

function removeFile(path: string, tally: Tally, note = ""): void {
  try {
    unlinkSync(path);
    tally.removed.push(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    tally.left.push(`cannot remove ${path}: ${reasonOf(error)}${note}`);
  }
}

/** Remove `dir` when nothing is in it. Anything in it is somebody's. */
function removeDirIfEmpty(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the desktop app's PATH line out of a shell profile. The write goes
 * through a symlink to the file it names, as the app's own write does, so a
 * profile kept in a dotfiles checkout stays a link, and the file keeps its
 * mode.
 */
function removeProfileBlock(path: string, tally: Tally): void {
  let text: string | undefined;
  try {
    text = readText(path);
  } catch (error) {
    tally.left.push(`${path} could not be read as text, left alone: ${reasonOf(error)}`);
    return;
  }
  if (text === undefined) return;
  const updated = removePathBlocks(text);
  if (updated === text) return;
  try {
    const real = realpathSync(path);
    writeFileAtomic(real, updated, { mode: statSync(real).mode & 0o7777 });
    tally.removed.push(`the Oxagen PATH lines in ${path}`);
  } catch (error) {
    tally.left.push(`cannot rewrite ${path}: ${reasonOf(error)}`);
  }
}

/**
 * The PowerShell `cli_install.rs` runs to drop a directory from the user
 * PATH (`REMOVE_FROM_USER_PATH_PS`). The directory travels in
 * `$env:OXAGEN_BIN`, never inside the script, so an apostrophe in a user
 * name cannot end a quoted string. Every other entry stays byte for byte.
 */
const REMOVE_FROM_USER_PATH_PS =
  "$d=$env:OXAGEN_BIN; $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $p=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -ne $p){ $all=@($p -split ';'); $e=@($all | Where-Object { $_ -ne $d }); if($e.Count -ne $all.Count){ $n=($e -join ';'); if($n -eq ''){ $k.DeleteValue('Path') } else { $k.SetValue('Path',$n,[Microsoft.Win32.RegistryValueKind]::ExpandString) }; [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('OXAGEN_PATH_CHANGED',$null,'User') } }; $k.Close()";

function removeFromUserPath(dir: string, deps: CliDeps, tally: Tally): void {
  if (deps.platform !== "win32") return;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", REMOVE_FROM_USER_PATH_PS],
    {
      env: { ...deps.env, OXAGEN_BIN: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.status === 0) tally.removed.push(`${dir} from your user PATH`);
  else
    tally.left.push(
      `${dir} is still on your user PATH: ${result.error?.message ?? ((result.stderr ?? "").trim() || `powershell exited ${String(result.status)}`)}`,
    );
}

/**
 * Undo one journal entry, but only while the thing is still what the app
 * wrote. A copy is left for step 3.
 */
function undoEntry(entry: JournalEntry, deps: CliDeps, tally: Tally): void {
  switch (entry.kind) {
    case "copy":
      return;
    case "link": {
      let current: string;
      try {
        if (!lstatSync(entry.path).isSymbolicLink()) {
          tally.left.push(
            `${entry.path} is no longer the link Oxagen made, left alone`,
          );
          return;
        }
        current = readlinkSync(entry.path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT")
          tally.left.push(`cannot read ${entry.path}: ${reasonOf(error)}`);
        return;
      }
      if (current !== entry.target) {
        tally.left.push(
          `${entry.path} now points at ${current}, not at the copy Oxagen linked, left alone`,
        );
        return;
      }
      removeFile(entry.path, tally);
      return;
    }
    case "shim":
    case "fish": {
      let text: string | undefined;
      try {
        text = readText(entry.path);
      } catch (error) {
        tally.left.push(`${entry.path} could not be read, left alone: ${reasonOf(error)}`);
        return;
      }
      if (text === undefined) return;
      const ours =
        entry.kind === "shim"
          ? text === entry.text
          : text.startsWith(MARKER_BEGIN);
      if (!ours) {
        tally.left.push(
          `${entry.path} is no longer the file Oxagen wrote, left alone`,
        );
        return;
      }
      removeFile(entry.path, tally);
      return;
    }
    case "profile":
      removeProfileBlock(entry.path, tally);
      return;
    case "user-path":
      removeFromUserPath(entry.path, deps, tally);
      return;
  }
}

/** The version directories under `copies`. A name that starts with a dot is not one. */
function versionDirs(copies: string): string[] {
  try {
    return readdirSync(copies, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(copies, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The journal's `copy` directories this command may empty: each one under
 * `copies`, where the app keeps its copies (`<data-local>/oxagen/bin/<version>`),
 * that is a real directory and not a link to one. The journal is a file in
 * the person's home directory, so a path in it is not trusted to delete
 * anywhere else. Any other entry is named in `left`, and nothing in it is
 * touched.
 */
function journaledCopies(
  journal: readonly JournalEntry[],
  copies: string,
  tally: Tally,
): string[] {
  const dirs: string[] = [];
  for (const entry of journal) {
    if (entry.kind !== "copy") continue;
    const rel = relative(copies, entry.path);
    // The bin directory itself: the pass over it below covers it.
    if (rel === "") continue;
    if (isAbsolute(rel) || rel.split(sep)[0] === "..") {
      tally.left.push(
        `${entry.path} is not under ${copies}, where the Oxagen app keeps its copies, so the oxagen and tacho in it were left alone. Delete them by hand if they are Oxagen's`,
      );
      continue;
    }
    try {
      if (!lstatSync(entry.path).isDirectory()) {
        tally.left.push(
          `${entry.path} is no longer the directory the Oxagen app made, left alone`,
        );
        continue;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        tally.left.push(`cannot read ${entry.path}: ${reasonOf(error)}`);
      continue;
    }
    dirs.push(resolve(entry.path));
  }
  return dirs;
}

/**
 * Remove the two sidecars from `dir`, and nothing else in it. Windows does
 * not delete a program's file while the program runs, and this command
 * usually runs from the copy it is removing.
 */
function removeSidecars(dir: string, platform: NodeJS.Platform, tally: Tally): void {
  const note =
    platform === "win32"
      ? `. Windows keeps a running program's file, so delete ${dir} after this command exits`
      : "";
  for (const name of ["oxagen", "tacho"]) {
    const file = join(dir, platform === "win32" ? `${name}.exe` : name);
    removeFile(file, tally, note);
  }
}

/**
 * Undo what the app's `created` list remembers: a file an install created
 * goes once it is empty, a directory once nothing is in it. What the person
 * has since put content in stays. Deepest first, so a directory is looked
 * at after what was in it.
 */
function removeCreated(created: readonly string[], tally: Tally): void {
  const deepestFirst = [...created].sort((a, b) => b.length - a.length);
  for (const path of deepestFirst) {
    let isDir: boolean;
    let size: number;
    try {
      const stat = lstatSync(path);
      isDir = stat.isDirectory();
      size = stat.size;
    } catch {
      continue;
    }
    if (isDir) {
      if (removeDirIfEmpty(path)) tally.removed.push(path);
    } else if (size === 0) {
      removeFile(path, tally);
    }
  }
}

/**
 * Take everything Oxagen put on this machine back off it, without the
 * desktop app. Runs under `unenroll`'s install lock for the unenroll, then
 * removes what the app's journal records. Nothing past the unenroll runs
 * while an enrollment is still on the machine.
 */
export async function uninstall(
  options: UninstallOptions,
  deps: CliDeps,
): Promise<UninstallResult> {
  const tally: Tally = { removed: [], left: [] };
  const places = desktopPlaces(deps);

  deps.out("Unenrolling every agent on this machine");
  const unenrolled = await unenroll(
    {
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.org !== undefined ? { org: options.org } : {}),
      ...(options.workspace !== undefined
        ? { workspace: options.workspace }
        : {}),
      ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
      reason: options.reason ?? "oxagen agent uninstall",
      all: true,
      purge: true,
    },
    deps,
  );
  const warnings = [...unenrolled.warnings];
  const agents = listAgents(deps.paths);
  if (!unenrolled.ok || agents.some(agentIsLive)) {
    const refusal =
      "the unenroll did not finish, so the per-user copy, the links, and the settings stay: a hook may still run them. Fix what the warnings above name, then run `oxagen agent uninstall` again";
    deps.err(`error: ${refusal}`);
    return { ok: false, removed: [], left: [], warnings: [...warnings, refusal] };
  }
  // A retired agent whose revoke the control plane did not confirm keeps
  // its host.json so a later unenroll can finish the revoke. That file goes
  // with the Tacho directory below, so name the agent now.
  const pending = agents.flatMap((agent) =>
    agent.host !== undefined && agent.host.revoked_at !== null
      ? [`${agent.host.agent_key} (${agent.host.host_enrollment_id})`]
      : [],
  );

  // Read before `~/.config/oxagen`, which holds it, goes.
  const record = readDesktopRecord(places.desktopConfig);
  if (record.problem !== undefined) warnings.push(record.problem);

  deps.out("Removing the command line links and the shell profile lines");
  for (const entry of record.journal) undoEntry(entry, deps, tally);
  if (!record.journaled) {
    const note =
      deps.platform === "win32"
        ? `No record of the Oxagen app's command line shims was found in ${places.desktopConfig}. Delete oxagen.cmd and tacho.cmd from the Oxagen\\bin folder in %LOCALAPPDATA%, and remove that folder from your user PATH`
        : `No record of the Oxagen app's command line links was found in ${places.desktopConfig}. If ~/.local/bin/oxagen or ~/.local/bin/tacho links into ${places.copies}, delete it, and delete the lines from "${MARKER_BEGIN}" to "${MARKER_END}" in your shell profile`;
    warnings.push(note);
  }

  deps.out("Removing the per-user copies and Oxagen's settings");
  const copyDirs = new Set([
    ...journaledCopies(record.journal, places.copies, tally),
    ...versionDirs(places.copies),
  ]);
  for (const dir of copyDirs) {
    removeSidecars(dir, deps.platform, tally);
    if (removeDirIfEmpty(dir)) tally.removed.push(dir);
  }
  // The copy releases before ADR-230 made in the directory itself.
  removeSidecars(places.copies, deps.platform, tally);
  removeCreated(record.created, tally);
  // The app's own two directories, once empty. They carry its name, so an
  // app that left no `created` list (or none this command could read) does
  // not leave them behind.
  for (const dir of [places.copies, dirname(places.copies)])
    if (removeDirIfEmpty(dir)) tally.removed.push(dir);
  for (const dir of [deps.paths.tachoDir, places.oxagenDir]) {
    try {
      lstatSync(dir);
    } catch {
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      tally.removed.push(dir);
    } catch (error) {
      tally.left.push(`cannot remove ${dir}: ${reasonOf(error)}`);
    }
  }
  // `~/.config` itself, only when the app recorded creating it and nothing
  // else is in it.
  const configDir = join(deps.home, ".config");
  if (record.configDirCreated && removeDirIfEmpty(configDir))
    tally.removed.push(configDir);

  for (const path of tally.removed) deps.out(`      removed ${path}`);
  for (const revoke of pending)
    warnings.push(
      `the control plane did not confirm the revoke of ${revoke}. Revoke it on the fleet page`,
    );
  // `unenroll` printed its own warnings already.
  for (const warning of warnings.slice(unenrolled.warnings.length))
    deps.err(`warning: ${warning}`);
  for (const item of tally.left) deps.err(`warning: ${item}`);
  deps.out(
    tally.left.length === 0
      ? "Oxagen is off this machine. Your `oxagen login` session went with ~/.config/oxagen, so run `oxagen login` again before you use the CLI. If the Oxagen app is still installed, remove it too, or it puts the per-user copy back the next time it opens."
      : "Oxagen is off this machine except for what the warnings above name.",
  );
  return {
    ok: tally.left.length === 0,
    removed: tally.removed,
    left: tally.left,
    warnings,
  };
}
