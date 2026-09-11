/**
 * Installing `tachod` as a user service (spec section 5.1 step 4): a launchd
 * agent on macOS, a systemd user unit on Linux. The unit files are rendered
 * by pure functions; the service manager calls are behind an `Exec` port so
 * tests run against a fake.
 */
import { join } from "node:path";
import { ensureDir, writeSensitiveFileAtomic } from "./fs";
import { existsSync, unlinkSync } from "node:fs";

export const SERVICE_LABEL = "sh.oxagen.tachod";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command and capture it; the daemon and the CLI inject the real one. */
export type Exec = (command: string, args: string[]) => ExecResult;

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
  running: boolean;
  detail?: string;
}

export interface ServiceManager {
  readonly kind: "launchd" | "systemd" | "none";
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

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
ExecStart=${spec.command.map(systemdQuote).join(" ")}
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
}

function launchdManager(options: ServiceManagerOptions): ServiceManager {
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
      const result = options.exec("launchctl", ["bootstrap", domain, unitPath]);
      if (result.status !== 0) {
        throw new Error(
          `launchctl bootstrap failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    },
    uninstall: () => {
      options.exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
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
      options.exec("systemctl", ["--user", "restart", "tachod.service"]);
    },
    uninstall: () => {
      options.exec("systemctl", [
        "--user",
        "disable",
        "--now",
        "tachod.service",
      ]);
      if (existsSync(unitPath)) unlinkSync(unitPath);
      options.exec("systemctl", ["--user", "daemon-reload"]);
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
  return noneManager();
}
