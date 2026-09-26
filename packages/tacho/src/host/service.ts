/**
 * Installing `tachod` as a user service (spec section 5.1 step 4): a launchd
 * agent on macOS, a systemd user unit on Linux, a per-user Task Scheduler
 * task on Windows. The unit files are rendered by pure functions; the
 * service manager calls are behind an `Exec` port so tests run against a
 * fake.
 */
import { join } from "node:path";
import { ensureDir, writeSensitiveFileAtomic } from "./fs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  isDaemonImage,
  parseDaemonPid,
  processExecutable,
} from "./process-scan";

export const SERVICE_LABEL = "sh.oxagen.tachod";
/** Task Scheduler names cannot carry dots; this is the Windows label. */
export const SCHTASKS_NAME = "OxagenTachod";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command and capture it; the daemon and the CLI inject the real one. */
export type Exec = (command: string, args: string[]) => ExecResult;

/**
 * The same port, without blocking the caller's event loop.
 *
 * `Exec` is implemented with `spawnSync` everywhere it is injected, which is
 * correct for the CLI and the service manager: both are short programs whose
 * next step depends on the command they just ran, and neither is serving
 * anything while it waits. The daemon is the opposite case. It answers hooks
 * on one event loop, and a synchronous spawn there stops it answering any
 * hook until the child exits. A hook that waits out its budget falls back to
 * deciding locally, which is the mandate going unenforced, so the daemon's
 * probes take this port instead and the synchronous one stays for its other
 * callers.
 */
export type ExecAsync = (
  command: string,
  args: string[],
) => Promise<ExecResult>;

export interface ServiceSpec {
  /** Program and arguments that run the daemon in the foreground. */
  command: string[];
  /** Environment the daemon needs (TACHO_HOME, PATH). */
  env: Record<string, string>;
  logPath: string;
  workingDirectory: string;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean | null;
  detail?: string;
}

export interface ServiceManager {
  readonly kind: "launchd" | "systemd" | "schtasks" | "none";
  readonly unitPath: string;
  install: (spec: ServiceSpec) => void;
  uninstall: () => void;
  status: () => ServiceStatus;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * How long launchd waits after SIGTERM before it SIGKILLs the daemon. The
 * daemon bounds its own shutdown (`STOP_GRACE_MS` in `collector/run.ts`), so
 * this is the backstop, and it sits well inside the `bootout` wait below.
 */
const LAUNCHD_EXIT_TIMEOUT_SEC = 10;

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const args = spec.command
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const env = Object.entries(spec.env)
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>${LAUNCHD_EXIT_TIMEOUT_SEC}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
  </dict>
</plist>
`;
}

/** Escape specifiers in unit values and variable expansion only in commands. */
function systemdQuote(value: string, command = false): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
  return `"${command ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

/**
 * How long systemd waits for the daemon to exit before it SIGKILLs it. The
 * daemon bounds its own shutdown to `STOP_GRACE_MS` (`collector/run.ts`),
 * because `stop()` awaits the git reconciliation lane, which can run for
 * minutes. This is the backstop for a daemon that hangs anyway. `stop()`
 * persists `state.json` before that wait, so a kill loses at most the final
 * seal, never the cursor. `systemctl restart` blocks for this long in the
 * worst case, so a re-enroll never waits minutes on it.
 */
const STOP_TIMEOUT_SEC = 10;

export function renderSystemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Tacho collector for Oxagen (tachod)
After=default.target

[Service]
Type=simple
ExecStart=${spec.command.map((value) => systemdQuote(value, true)).join(" ")}
WorkingDirectory=${spec.workingDirectory}
${env}
Restart=always
RestartSec=2
TimeoutStopSec=${STOP_TIMEOUT_SEC}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export interface ServiceManagerOptions {
  platform: NodeJS.Platform;
  home: string;
  exec: Exec;
  /** The user's uid, for `launchctl bootstrap gui/<uid>`. */
  uid?: number;
  /** Block for `ms`. Injected so a test does not wait out the retries. */
  sleep?: (ms: number) => void;
  /** Where the Windows launcher `.cmd` is written (`TachoPaths.daemonLauncher`). */
  launcherPath?: string;
  /**
   * The daemon's pid file (`TachoPaths.pid`), the handle the Windows manager
   * stops and observes the daemon by. Defaults to `tachod.pid` next to the
   * launcher.
   */
  pidPath?: string;
  /**
   * Signal a pid and read the executable it runs. With no systemd user
   * manager to ask, the systemd manager stops a daemon run by hand through
   * its pid file with these. `process.kill` and `/proc` unless injected.
   */
  processes?: {
    kill: (pid: number, signal: NodeJS.Signals) => void;
    executable: (pid: number) => string | undefined;
  };
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How long `install` and `uninstall` wait for launchd to drop a label after
 * `bootout`: 30 polls 500 ms apart, about 15 s. `bootout` only marks the
 * label for removal. launchd removes it when the old daemon exits, and the
 * daemon's SIGTERM path can take several seconds (`STOP_GRACE_MS` in
 * `collector/run.ts` bounds it). launchd kills it at `LAUNCHD_EXIT_TIMEOUT_SEC`,
 * well inside this window.
 *
 * Counted in polls rather than read from a clock so a test that injects a
 * no-op `sleep` does not spin for 15 real seconds.
 */
const BOOTOUT_WAIT_POLLS = 30;
const BOOTOUT_POLL_MS = 500;
/** Retries for a `bootstrap` that launchd refuses once the label is gone. */
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 400;

function launchdManager(options: ServiceManagerOptions): ServiceManager {
  const sleep = options.sleep ?? blockingSleep;
  const dir = join(options.home, "Library", "LaunchAgents");
  const unitPath = join(dir, `${SERVICE_LABEL}.plist`);
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 501}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  /** `print` answers 0 for a loaded label and non-zero for any other. */
  const loaded = () =>
    options.exec("launchctl", ["print", target]).status === 0;
  /** Poll until launchd has dropped the label; false if it never did. */
  const waitUntilGone = (): boolean => {
    for (let poll = 0; poll < BOOTOUT_WAIT_POLLS; poll += 1) {
      if (!loaded()) return true;
      sleep(BOOTOUT_POLL_MS);
    }
    return !loaded();
  };
  const stillLoaded = (then: string) =>
    new Error(
      `${SERVICE_LABEL} is still loaded ${Math.round((BOOTOUT_WAIT_POLLS * BOOTOUT_POLL_MS) / 1000)} s after launchctl bootout. Run \`launchctl bootout ${target}\`, then ${then} again`,
    );
  return {
    kind: "launchd",
    unitPath,
    install: (spec) => {
      const plist = renderLaunchdPlist(spec);
      // An unchanged plist on a loaded service needs a restart, not a reload.
      // `kickstart -k` kills the running instance and starts it again under
      // the same label, so there is no window in which the label is gone.
      // A plist that is unchanged but not loaded is the state a failed
      // re-enroll leaves behind, and it takes the bootstrap path below.
      const unchanged =
        existsSync(unitPath) && readFileSync(unitPath, "utf8") === plist;
      if (unchanged && loaded()) {
        const kicked = options.exec("launchctl", ["kickstart", "-k", target]);
        if (kicked.status === 0 && loaded()) return;
      }
      ensureDir(dir, 0o755);
      writeSensitiveFileAtomic(unitPath, plist, 0o644);
      options.exec("launchctl", ["bootout", target]);
      // `bootout` returns before the old instance has gone. A `bootstrap`
      // that lands in that window is either refused ("Bootstrap failed: 5:
      // Input/output error") or accepted and then removed when the old
      // process finally exits, which leaves the plist on disk and no service
      // in launchd. Wait for the label to go first.
      if (!waitUntilGone()) throw stillLoaded("enroll");
      // A label turned off in Login Items is disabled in launchd too, and
      // `bootstrap` then fails with an opaque error 5. Enrolling is the user
      // asking for the daemon, so the label is enabled first; a failure here
      // surfaces as the bootstrap failure below.
      options.exec("launchctl", ["enable", target]);
      let result = options.exec("launchctl", ["bootstrap", domain, unitPath]);
      for (
        let attempt = 1;
        result.status !== 0 && attempt < BOOTSTRAP_ATTEMPTS;
        attempt += 1
      ) {
        sleep(BOOTSTRAP_RETRY_MS);
        result = options.exec("launchctl", ["bootstrap", domain, unitPath]);
      }
      if (result.status !== 0) {
        throw new Error(
          `launchctl bootstrap failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}. If tachod is turned off in Login Items, turn it on; \`launchctl print-disabled ${domain}\` lists what launchd has disabled`,
        );
      }
      if (!loaded()) {
        throw new Error(
          `launchctl bootstrap reported success, but launchd has no ${SERVICE_LABEL} service. The plist is at ${unitPath}; run \`launchctl bootstrap ${domain} ${unitPath}\` to load it`,
        );
      }
    },
    uninstall: () => {
      options.exec("launchctl", ["bootout", target]);
      // `bootout` answers non-zero both for "was not loaded" and for "could
      // not unload", so its status says nothing. `print` does: while it
      // answers 0 the daemon is still running, and deleting the plist then
      // leaves a collector nothing on disk accounts for until the next
      // logout. The plist stays so the retry has something to boot out.
      if (!waitUntilGone()) throw stillLoaded("unenroll");
      if (existsSync(unitPath)) unlinkSync(unitPath);
    },
    status: () => {
      const installed = existsSync(unitPath);
      const result = options.exec("launchctl", [
        "print",
        `${domain}/${SERVICE_LABEL}`,
      ]);
      const running =
        result.status === 0 && /state = running/.test(result.stdout);
      return { installed, running, detail: result.stdout.split("\n")[0] ?? "" };
    },
  };
}

/**
 * Whether systemctl is missing, or has no user manager to talk to: WSL
 * without systemd, a container, a host booted with another init.
 */
function noUserManager(result: ExecResult): boolean {
  return (
    (result.status === null && /ENOENT/.test(result.stderr)) ||
    /Failed to connect to bus|not been booted with systemd|System has not been booted/.test(
      result.stderr,
    )
  );
}

/**
 * How long a daemon stopped by its pid gets to shut down before SIGKILL:
 * about 10 s, the same backstop as `STOP_TIMEOUT_SEC`. The daemon bounds its
 * own shutdown to `STOP_GRACE_MS` (`collector/run.ts`).
 */
const PID_STOP_ATTEMPTS = 25;
const PID_STOP_POLL_MS = 400;

/**
 * Stop the daemon `tachod.pid` names, when that pid still runs the daemon's
 * executable: SIGTERM, a bounded wait for its own shutdown, then SIGKILL. A
 * pid another program now holds is left alone.
 */
function stopByPidFile(options: ServiceManagerOptions): void {
  const { pidPath } = options;
  if (pidPath === undefined || !existsSync(pidPath)) return;
  const record = parseDaemonPid(readFileSync(pidPath, "utf8"));
  if (record === undefined) return;
  const sleep = options.sleep ?? blockingSleep;
  const processes = options.processes ?? {
    kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    executable: processExecutable,
  };
  const running = () => {
    const exe = processes.executable(record.pid);
    return exe !== undefined && isDaemonImage(record, exe);
  };
  const signal = (name: NodeJS.Signals) => {
    try {
      processes.kill(record.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (!running()) return;
  signal("SIGTERM");
  for (let attempt = 0; running() && attempt < PID_STOP_ATTEMPTS; attempt += 1)
    sleep(PID_STOP_POLL_MS);
  if (running()) {
    signal("SIGKILL");
    sleep(PID_STOP_POLL_MS);
  }
  if (running())
    throw new Error(
      `The daemon could not be stopped: pid ${record.pid} is still running`,
    );
}

function systemdManager(options: ServiceManagerOptions): ServiceManager {
  const dir = join(options.home, ".config", "systemd", "user");
  const unitPath = join(dir, "tachod.service");
  return {
    kind: "systemd",
    unitPath,
    install: (spec) => {
      // Without a user manager every systemctl call below fails, and a unit
      // written first is left on disk for nothing. Asking first lets the
      // failure say what is missing.
      const probe = options.exec("systemctl", ["--user", "show-environment"]);
      if (noUserManager(probe))
        throw new Error(
          `no systemd user manager is available (${probe.stderr.trim().split("\n")[0] ?? ""})`,
        );
      ensureDir(dir, 0o755);
      writeSensitiveFileAtomic(unitPath, renderSystemdUnit(spec), 0o644);
      const reload = options.exec("systemctl", ["--user", "daemon-reload"]);
      if (reload.status !== 0) {
        throw new Error(
          `systemctl daemon-reload failed: ${reload.stderr.trim()}`,
        );
      }
      const enable = options.exec("systemctl", [
        "--user",
        "enable",
        "--now",
        "tachod.service",
      ]);
      if (enable.status !== 0) {
        throw new Error(`systemctl enable failed: ${enable.stderr.trim()}`);
      }
      const restart = options.exec("systemctl", [
        "--user",
        "restart",
        "tachod.service",
      ]);
      if (restart.status !== 0)
        throw new Error(`systemctl restart failed: ${restart.stderr.trim()}`);
    },
    uninstall: () => {
      const disabled = options.exec("systemctl", [
        "--user",
        "disable",
        "--now",
        "tachod.service",
      ]);
      // With no user manager there is no service to disable: the unit was
      // never loaded, and a daemon here was started by hand. It is stopped
      // by its pid file and the unit removed, or unenroll could never finish
      // on such a host.
      if (noUserManager(disabled)) {
        stopByPidFile(options);
        if (existsSync(unitPath)) unlinkSync(unitPath);
        return;
      }
      const active = options.exec("systemctl", [
        "--user",
        "is-active",
        "tachod.service",
      ]);
      // Inactive (3) and unknown (4) are the only stopped states. A bus
      // failure or a still-active service must retain the unit for retry.
      const stopped =
        (active.status === 3 &&
          ["inactive", "failed"].includes(active.stdout.trim())) ||
        (active.status === 4 && active.stdout.trim() === "unknown");
      if (!stopped || (disabled.status !== 0 && existsSync(unitPath))) {
        throw new Error(
          `systemctl could not remove tachod.service: ${disabled.stderr.trim() || active.stderr.trim() || active.stdout.trim() || "service state is unknown"}`,
        );
      }
      const unit = existsSync(unitPath)
        ? readFileSync(unitPath, "utf8")
        : undefined;
      if (unit !== undefined) unlinkSync(unitPath);
      try {
        const reload = options.exec("systemctl", ["--user", "daemon-reload"]);
        if (reload.status !== 0)
          throw new Error(
            `systemctl daemon-reload failed: ${reload.stderr.trim()}`,
          );
      } catch (error) {
        if (unit !== undefined) writeSensitiveFileAtomic(unitPath, unit, 0o644);
        throw error;
      }
    },
    status: () => {
      const installed = existsSync(unitPath);
      const result = options.exec("systemctl", [
        "--user",
        "is-active",
        "tachod.service",
      ]);
      return {
        installed,
        running: result.stdout.trim() === "active",
        detail: result.stdout.trim(),
      };
    },
  };
}

/**
 * The launcher the Windows task runs: a `.cmd` that sets the daemon's env
 * (Task Scheduler cannot carry environment variables) and runs `tachod`
 * with stdout and stderr appended to the log, restarting it when it exits
 * as launchd's KeepAlive and systemd's Restart=always do. Rendered as a pure
 * function.
 *
 * cmd.exe reads a batch file in the console code page, not UTF-8, so the
 * launcher switches to 65001 before any line that carries a path; and it
 * expands `%` anywhere in a line, so every value's `%` is doubled.
 *
 * The loop runs while the file still carries this launcher's `generation`
 * (`findstr` answering 1; a `findstr` that cannot run is no reason to stop).
 * Each install writes a new one and uninstall deletes the file, so a
 * launcher left from an earlier install stops at its next restart instead
 * of starting a second daemon beside the new one. The loop body is one
 * parenthesized block, which cmd reads whole, so a launcher rewritten while
 * the daemon runs is never read from the middle of a line. A restart waits
 * 5 s, and every fifth one a minute, so a daemon that dies as it starts is
 * retried without the loop spinning.
 */
export function renderWindowsLauncher(
  spec: ServiceSpec,
  generation = "0",
): string {
  const escape = (value: string) => value.replace(/%/g, "%%");
  const cmdQuote = (value: string) => `"${escape(value).replace(/"/g, '""')}"`;
  const env = Object.entries(spec.env)
    .map(
      ([key, value]) =>
        `set "${escape(key)}=${escape(value.replace(/"/g, ""))}"`,
    )
    .join("\r\n");
  const command = spec.command.map(cmdQuote).join(" ");
  const system = "%SystemRoot%\\System32";
  const ping = (count: number) =>
    `"${system}\\PING.EXE" -n ${count} 127.0.0.1 >nul`;
  return [
    "@echo off",
    `"${system}\\chcp.com" 65001 >nul`,
    "rem Oxagen Tacho collector launcher; written by `tacho enroll`.",
    env,
    `set "TACHOD_LAUNCHER=${generation}"`,
    "set TACHOD_RESTARTS=0",
    `cd /d ${cmdQuote(spec.workingDirectory)}`,
    ":run",
    "(",
    `"${system}\\findstr.exe" /c:"TACHOD_LAUNCHER=%TACHOD_LAUNCHER%" "%~f0" >nul 2>&1`,
    "if errorlevel 1 if not errorlevel 2 exit",
    `${command} >> ${cmdQuote(spec.logPath)} 2>&1`,
    'set /a "TACHOD_RESTARTS=(TACHOD_RESTARTS+1) %% 5"',
    ping(6),
    `if %TACHOD_RESTARTS% equ 4 ${ping(56)}`,
    "goto run",
    ")",
    "",
  ].join("\r\n");
}

/** The image name `tasklist /FO CSV` lists for `pid`, its first column. */
function tasklistImage(listing: string, pid: number): string | undefined {
  for (const line of listing.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match !== null && Number(match[2]) === pid) return match[1];
  }
  return undefined;
}

/**
 * Task Scheduler is the per-user equivalent of a launchd agent: `/SC ONLOGON`
 * starts it at sign-in, `/RL LIMITED` keeps it unelevated, and `/Run` starts
 * it right away. The task is hidden from the foreground with `cmd /c start
 * /min` so the collector does not own a console window.
 *
 * The daemon is stopped and observed by its pid, never by the task: the
 * task's action is `cmd /c start`, which returns as soon as the launcher is
 * handed off, so the task's own status says nothing reliable about the
 * daemon, and the daemon's image is `tacho.exe` (multi-call) or `node.exe`
 * (bundle), so no image name alone identifies it either. `runDaemonProcess`
 * writes `tachod.pid` with its pid and executable; that is the handle. A
 * stale pid file (the process is gone, or Windows gave the pid to a
 * program with another image name) reads as stopped.
 */
function schtasksManager(options: ServiceManagerOptions): ServiceManager {
  const launcher = options.launcherPath ?? join(options.home, "tachod.cmd");
  const pidPath = options.pidPath ?? join(launcher, "..", "tachod.pid");
  /** The pid in `tachod.pid` when that process is still the daemon. */
  const livePid = (): number | undefined => {
    if (!existsSync(pidPath)) return undefined;
    const record = parseDaemonPid(readFileSync(pidPath, "utf8"));
    if (record === undefined) return undefined;
    const { pid } = record;
    const query = options.exec("tasklist", [
      "/FI",
      `PID eq ${pid}`,
      "/NH",
      "/FO",
      "CSV",
    ]);
    if (query.status !== 0)
      throw new Error(
        `Cannot inspect daemon pid ${pid}: ${query.stderr.trim() || "tasklist failed"}`,
      );
    const image = tasklistImage(query.stdout, pid);
    return image !== undefined && isDaemonImage(record, image)
      ? pid
      : undefined;
  };
  /**
   * Stop whatever the task started: end the task instance (harmless when
   * none is running) and kill the daemon's process tree by pid. `install`
   * does this before `/Run` so a re-enroll or reassign never starts a
   * second daemon on the reused port (the first would keep answering for
   * the old enrollment while the second dies with EADDRINUSE). The
   * launcher's loop outlives the kill and ends at its next restart, once
   * install has rewritten the launcher or uninstall has deleted it.
   */
  const stopDaemon = () => {
    options.exec("schtasks", ["/End", "/TN", SCHTASKS_NAME]);
    const pid = livePid();
    if (pid !== undefined) {
      const killed = options.exec("taskkill", [
        "/PID",
        String(pid),
        "/T",
        "/F",
      ]);
      if (killed.status !== 0 || livePid() !== undefined) {
        throw new Error(
          `The daemon could not be stopped: ${killed.stderr.trim() || `pid ${pid} is still running`}`,
        );
      }
    }
  };
  return {
    kind: "schtasks",
    unitPath: launcher,
    install: (spec) => {
      // Stopped before the launcher is rewritten: a launcher from before the
      // restart loop reads its next line at its old offset, and that offset
      // must still be the end of its own file.
      stopDaemon();
      ensureDir(join(launcher, ".."), 0o755);
      writeSensitiveFileAtomic(
        launcher,
        renderWindowsLauncher(
          // The launcher runs from the profile directory, not the Tacho
          // root. A running cmd.exe holds its working directory open, and
          // the launcher lives on for up to a minute after uninstall kills
          // the daemon, until its loop reads that its file is gone. From the
          // Tacho root it kept `unenroll --purge` from removing the root, and
          // an empty directory stayed behind (#4317). The daemon uses
          // absolute paths only.
          { ...spec, workingDirectory: options.home },
          randomBytes(8).toString("hex"),
        ),
        0o600,
      );
      options.exec("schtasks", ["/Delete", "/TN", SCHTASKS_NAME, "/F"]);
      const create = options.exec("schtasks", [
        "/Create",
        "/TN",
        SCHTASKS_NAME,
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/F",
        "/TR",
        `cmd /c start /min "" "${launcher}"`,
      ]);
      if (create.status !== 0) {
        throw new Error(
          `schtasks /Create failed (${create.status ?? "signal"}): ${create.stderr.trim() || create.stdout.trim()}`,
        );
      }
      const run = options.exec("schtasks", ["/Run", "/TN", SCHTASKS_NAME]);
      if (run.status !== 0) {
        throw new Error(
          `schtasks /Run failed (${run.status ?? "signal"}): ${run.stderr.trim() || run.stdout.trim()}`,
        );
      }
    },
    uninstall: () => {
      stopDaemon();
      const deleted = options.exec("schtasks", [
        "/Delete",
        "/TN",
        SCHTASKS_NAME,
        "/F",
      ]);
      if (
        deleted.status !== 0 &&
        !/cannot find|not found/i.test(deleted.stderr)
      ) {
        throw new Error(
          `schtasks /Delete failed: ${deleted.stderr.trim() || "task removal was not confirmed"}`,
        );
      }
      if (existsSync(launcher)) unlinkSync(launcher);
    },
    status: () => {
      const result = options.exec("schtasks", [
        "/Query",
        "/TN",
        SCHTASKS_NAME,
        "/FO",
        "LIST",
      ]);
      const installed = result.status === 0;
      let pid: number | undefined;
      try {
        pid = livePid();
      } catch (error) {
        return {
          installed,
          running: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        installed,
        running: pid !== undefined,
        detail: !installed
          ? "not installed"
          : pid !== undefined
            ? `pid ${pid}`
            : "no daemon process",
      };
    },
  };
}

function noneManager(): ServiceManager {
  return {
    kind: "none",
    unitPath: "",
    install: () => {
      throw new Error(
        "no user service manager on this platform; run `tacho daemon` yourself",
      );
    },
    uninstall: () => undefined,
    status: () => ({
      installed: false,
      running: false,
      detail: "unsupported platform",
    }),
  };
}

export function serviceManagerFor(
  options: ServiceManagerOptions,
): ServiceManager {
  if (options.platform === "darwin") return launchdManager(options);
  if (options.platform === "linux") return systemdManager(options);
  if (options.platform === "win32") return schtasksManager(options);
  return noneManager();
}
