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
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** launchd needs a moment to let go of a label it has just booted out. */
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 400;

function launchdManager(options: ServiceManagerOptions): ServiceManager {
  const sleep = options.sleep ?? blockingSleep;
  const dir = join(options.home, "Library", "LaunchAgents");
  const unitPath = join(dir, `${SERVICE_LABEL}.plist`);
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 501}`;
  return {
    kind: "launchd",
    unitPath,
    install: (spec) => {
      ensureDir(dir, 0o755);
      writeSensitiveFileAtomic(unitPath, renderLaunchdPlist(spec), 0o644);
      options.exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
      // `bootout` returns before the old instance has gone, and a
      // `bootstrap` that lands in that window fails with "Bootstrap failed:
      // 5: Input/output error". Every re-enroll and reassign does exactly
      // this pair, so it is retried instead of reported as "service install
      // failed; run `tacho daemon` yourself" on a machine where nothing is
      // wrong.
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
          `launchctl bootstrap failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    },
    uninstall: () => {
      options.exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
      // `bootout` answers non-zero both for "was not loaded" and for "could
      // not unload", so its status says nothing. `print` does: while it
      // answers 0 the daemon is still running, and deleting the plist then
      // leaves a collector nothing on disk accounts for until the next
      // logout. The plist stays so the retry has something to boot out.
      let loaded =
        options.exec("launchctl", ["print", `${domain}/${SERVICE_LABEL}`])
          .status === 0;
      for (
        let attempt = 1;
        loaded && attempt < BOOTSTRAP_ATTEMPTS;
        attempt += 1
      ) {
        sleep(BOOTSTRAP_RETRY_MS);
        loaded =
          options.exec("launchctl", ["print", `${domain}/${SERVICE_LABEL}`])
            .status === 0;
      }
      if (loaded)
        throw new Error(
          `${SERVICE_LABEL} is still loaded after launchctl bootout. Run \`launchctl bootout ${domain}/${SERVICE_LABEL}\`, then unenroll again`,
        );
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

function systemdManager(options: ServiceManagerOptions): ServiceManager {
  const dir = join(options.home, ".config", "systemd", "user");
  const unitPath = join(dir, "tachod.service");
  return {
    kind: "systemd",
    unitPath,
    install: (spec) => {
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
 * (Task Scheduler cannot carry environment variables) and starts `tachod`
 * with stdout and stderr appended to the log. Rendered as a pure function.
 */
export function renderWindowsLauncher(spec: ServiceSpec): string {
  const cmdQuote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const env = Object.entries(spec.env)
    .map(([key, value]) => `set "${key}=${value.replace(/"/g, "")}"`)
    .join("\r\n");
  const command = spec.command.map(cmdQuote).join(" ");
  return [
    "@echo off",
    "rem Oxagen Tacho collector launcher; written by `tacho enroll`.",
    env,
    `cd /d ${cmdQuote(spec.workingDirectory)}`,
    `${command} >> ${cmdQuote(spec.logPath)} 2>&1`,
    "",
  ].join("\r\n");
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
 * (bundle), so no image name identifies it either. `runDaemonProcess`
 * writes `tachod.pid`; that is the handle. A stale pid file (the process is
 * gone) reads as stopped.
 */
function schtasksManager(options: ServiceManagerOptions): ServiceManager {
  const launcher = options.launcherPath ?? join(options.home, "tachod.cmd");
  const pidPath = options.pidPath ?? join(launcher, "..", "tachod.pid");
  /** The pid in `tachod.pid` when that process exists. */
  const livePid = (): number | undefined => {
    if (!existsSync(pidPath)) return undefined;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
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
    return query.stdout.includes(`"${pid}"`) ? pid : undefined;
  };
  /**
   * Stop whatever the task started: end the task instance (harmless when
   * none is running) and kill the daemon's process tree by pid. `install`
   * does this before `/Run` so a re-enroll or reassign never starts a
   * second daemon on the reused port (the first would keep answering for
   * the old enrollment while the second dies with EADDRINUSE).
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
      ensureDir(join(launcher, ".."), 0o755);
      writeSensitiveFileAtomic(launcher, renderWindowsLauncher(spec), 0o600);
      stopDaemon();
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
