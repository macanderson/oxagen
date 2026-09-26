/**
 * Which `claude` processes are running on this host. Feeds the unobserved
 * session detector (spec section 11) and the `cancel` command's kill (7.4).
 * Uses `ps` through the `Exec` port so tests supply a fixed listing. Also
 * reads and writes `tachod.pid`, the record the service managers stop the
 * daemon by.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { win32 } from "node:path";
import type { Exec, ExecAsync, ExecResult } from "./service";

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

/**
 * `ps` prints `lstart` in its own time zone and locale. A laptop that
 * changes zone while the daemon runs, or a daemon restarted from a shell
 * with a different `LANG` than the service manager's, would print a
 * different string for the same process, and every session would read as a
 * new process. The zone is pinned to UTC and the locale to C.
 */
const PS_ENV = { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" };

function psExec(command: string, args: string[]): ReturnType<Exec> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: PS_ENV,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_START_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: "",
  };
}

/** `psExec` without holding the event loop while `ps` runs. */
function psExecAsync(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", env: PS_ENV, timeout: PROCESS_START_TIMEOUT_MS },
      (error, stdout) => {
        const code = (error as (Error & { code?: number | string }) | null)
          ?.code;
        resolve({
          status: error === null ? 0 : typeof code === "number" ? code : null,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: "",
        });
      },
    );
  });
}

/** A file's text, or undefined when it cannot be read. */
export type ReadText = (path: string) => string | undefined;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The start time in `/proc/<pid>/stat`: field 22, in clock ticks after boot.
 * The command name (field 2) sits in parentheses and may hold spaces and
 * parentheses itself, so the fields are counted from the last `)`.
 */
export function procStartTicks(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // Fields 3 onward, so field 22 is the twentieth.
  const ticks = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
}

/**
 * Start times on Linux, from `/proc`. `ps -o lstart=` is no identity there:
 * procps prints it as the boot time plus the start ticks, and the kernel
 * moves the boot time whenever the wall clock is stepped (an NTP step after
 * a resume, a WSL2 resync, a manual set). One step made every recorded start
 * time differ from the one `ps` printed next, so every live session read as
 * a pid the OS had handed on. The ticks do not move with the clock. The boot
 * id goes with them, because the ticks start over at every boot. Reading a
 * file spawns nothing.
 */
function readProcStarts(
  pids: readonly number[],
  read: ReadText,
): Map<number, string> | undefined {
  const boot = read("/proc/sys/kernel/random/boot_id")?.trim();
  if (boot === undefined || boot.length === 0) return undefined;
  const out = new Map<number, string>();
  for (const pid of pids) {
    const stat = read(`/proc/${pid}/stat`);
    const ticks = stat === undefined ? undefined : procStartTicks(stat);
    if (ticks !== undefined) out.set(pid, `${boot}:${ticks}`);
  }
  return out;
}

/** The start times in a `ps -o pid=,lstart=` answer, by pid. */
function parsePsStarts(
  pids: readonly number[],
  result: ExecResult,
): Map<number, string> | undefined {
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

const PS_START_ARGS = (pids: readonly number[]) => [
  "-o",
  "pid=,lstart=",
  "-p",
  pids.join(","),
];

/**
 * When each of these processes started, by pid. A pid is identified by its
 * number and its start time together, because the OS hands a freed pid to
 * the next process it starts. The value is only compared with another read
 * of the same pid, never parsed as a date.
 *
 * On Linux it is the boot id and the start ticks from `/proc`
 * (`readProcStarts` says why not `ps`). Elsewhere it is `ps -o lstart=` in
 * UTC, one call for the whole list (BSD `ps` takes a comma list after
 * `-p`). macOS keeps the start time the kernel stored at fork, so a clock
 * step does not change what `ps` prints for a running process.
 *
 * A pid with no process is left out. Undefined when nothing can answer, and
 * always on Windows, which has no `ps`: a caller then has no start time to
 * compare and falls back to the bare pid.
 */
export function readProcessStarts(
  pids: readonly number[],
  exec: Exec = psExec,
  platform: NodeJS.Platform = process.platform,
  read: ReadText = readText,
): Map<number, string> | undefined {
  if (platform === "win32" || pids.length === 0) return undefined;
  if (platform === "linux") return readProcStarts(pids, read);
  return parsePsStarts(pids, exec("ps", PS_START_ARGS(pids)));
}

/**
 * `readProcessStarts` without holding the event loop while `ps` runs. The
 * sweep reads every live session's pid this way before it takes the queue
 * hooks wait on.
 */
export async function readProcessStartsAsync(
  pids: readonly number[],
  exec: ExecAsync = psExecAsync,
  platform: NodeJS.Platform = process.platform,
  read: ReadText = readText,
): Promise<Map<number, string> | undefined> {
  if (platform === "win32" || pids.length === 0) return undefined;
  if (platform === "linux") return readProcStarts(pids, read);
  return parsePsStarts(pids, await exec("ps", PS_START_ARGS(pids)));
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
