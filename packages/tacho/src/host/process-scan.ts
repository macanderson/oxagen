/**
 * Which `claude` processes are running on this host. Feeds the unobserved
 * session detector (spec section 11) and the `cancel` command's kill (7.4).
 * Uses `ps` through the `Exec` port so tests supply a fixed listing. Also
 * reads and writes `tachod.pid`, the record the service managers stop the
 * daemon by.
 */
import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { win32 } from "node:path";
import type { Exec } from "./service";

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  command: string;
  /** Present when the command line carries an explicit `--resume`/`-r`. */
  resumeArg?: string;
}

const CLAUDE_BINARY = /(^|\/)claude(\s|$)/;
const CLAUDE_VERSIONS_DIR = /\/claude\/versions\/\d+\.\d+\.\d+/;

export function parsePsListing(listing: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = (match[3] ?? "").trim();
    const first = command.split(/\s+/, 1)[0] ?? "";
    if (!CLAUDE_BINARY.test(first) && !CLAUDE_VERSIONS_DIR.test(first))
      continue;
    const resume = /(?:--resume|-r)(?:=|\s+)([^\s]+)/.exec(command);
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command,
      ...(resume?.[1] !== undefined ? { resumeArg: resume[1] } : {}),
    });
  }
  return out;
}

export function listClaudeProcesses(exec: Exec): ClaudeProcess[] {
  const result = exec("ps", ["-axo", "pid=,ppid=,command="]);
  if (result.status !== 0) return [];
  return parsePsListing(result.stdout);
}

/** How long one `ps` read of start times may take. */
const PROCESS_START_TIMEOUT_MS = 2_000;

function psExec(command: string, args: string[]): ReturnType<Exec> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_START_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: "",
  };
}

/**
 * When each of these processes started, as `ps -o lstart=` prints it, by
 * pid: one `ps` call for the whole list (BSD and GNU `ps` both take a comma
 * list after `-p`). A pid is identified by its number and its start time
 * together, because the OS hands a freed pid to the next process it starts.
 *
 * A pid with no process is left out. Undefined when `ps` cannot answer, and
 * always on Windows, which has no `ps`: a caller then has no start time to
 * compare and falls back to the bare pid.
 */
export function readProcessStarts(
  pids: readonly number[],
  exec: Exec = psExec,
  platform: NodeJS.Platform = process.platform,
): Map<number, string> | undefined {
  if (platform === "win32" || pids.length === 0) return undefined;
  const result = exec("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
  // `ps` exits 1, printing nothing, when none of the pids names a process.
  const noneRunning = result.status === 1 && result.stdout.trim() === "";
  if (result.status !== 0 && !noneRunning) return undefined;
  const wanted = new Set(pids);
  const out = new Map<number, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const started = (match[2] ?? "").trim().replace(/\s+/g, " ");
    if (wanted.has(pid) && started.length > 0) out.set(pid, started);
  }
  return out;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * What `tachod.pid` holds: the daemon's pid, when it started and the
 * executable it runs. A pid alone cannot tell the daemon from an unrelated
 * process given the same pid after the daemon died (Windows reuses pids
 * quickly), and stopping by that pid then kills a process tree that has
 * nothing to do with Oxagen. The executable is what a reader checks before
 * it acts on the pid.
 */
export interface DaemonPidRecord {
  pid: number;
  /** Absent in the plain pid an older daemon wrote. */
  started_at?: string;
  /** `process.execPath`; absent in the plain pid an older daemon wrote. */
  exe?: string;
}

export function formatDaemonPid(record: Required<DaemonPidRecord>): string {
  return `${JSON.stringify(record)}\n`;
}

/** The record in `tachod.pid`: JSON, or the plain pid an older daemon wrote. */
export function parseDaemonPid(text: string): DaemonPidRecord | undefined {
  const trimmed = text.trim();
  let value: unknown = trimmed;
  if (!/^\d+$/.test(trimmed)) {
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  const record: Record<string, unknown> =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : { pid: Number(value) };
  const pid = record["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return undefined;
  return {
    pid,
    ...(typeof record["started_at"] === "string"
      ? { started_at: record["started_at"] }
      : {}),
    ...(typeof record["exe"] === "string" ? { exe: record["exe"] } : {}),
  };
}

/**
 * The daemon runs as `tacho` (the compiled binary, multi-call) or `node`
 * (the bundle). A plain pid file names no executable, so these are what its
 * process may be.
 */
const DAEMON_IMAGES = ["tacho", "node"];

/**
 * Whether the process image (a Windows image name such as `tacho.exe`, or an
 * executable path) is the one `record` says the daemon runs.
 */
export function isDaemonImage(record: DaemonPidRecord, image: string): boolean {
  const name = win32.basename(image).toLowerCase();
  if (record.exe !== undefined)
    return name === win32.basename(record.exe).toLowerCase();
  return DAEMON_IMAGES.some(
    (daemon) => name === daemon || name === `${daemon}.exe`,
  );
}

/**
 * The executable a live pid runs (Linux), or undefined when it is gone or
 * is not this user's. The kernel marks a binary replaced on disk since the
 * process started with " (deleted)"; that suffix is not part of its name.
 */
export function processExecutable(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    return undefined;
  }
}
