/**
 * The install and uninstall rig: a scratch HOME seeded the way a real
 * developer's machine looks, a fake `launchctl` / `systemctl`, a fake control
 * plane, and a tree snapshot (paths, modes, content hashes, link targets).
 * On Windows the fake is `schtasks` with `tasklist` and `taskkill`, and the
 * daemon it starts writes its pid file the way `runDaemonProcess` does.
 *
 * Nothing here touches the real home directory, the real LaunchAgents or a
 * real service manager: every path hangs off a `mkdtemp` directory and every
 * process the CLI would spawn goes through the `exec` fake. The suite in
 * `install-rig.test.ts` drives it, and the desktop app's `test:rig` script
 * runs that suite.
 *
 * Test support, not part of the public surface.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FetchLike } from "../host/control-client";
import { formatDaemonPid } from "../host/process-scan";
import type { Exec } from "../host/service";
import {
  bundleSigner,
  type FakeCodexAppServer,
  fakeCodexAppServer,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { TACHO_VERSION } from "../version";
import type { EnrollmentResponse } from "../wire";
import { type CliDeps, defaultCliDeps } from "./deps";

/** One entry of a tree snapshot. */
export interface SnapshotEntry {
  type: "file" | "dir" | "link";
  /** Permission bits only (`mode & 0o777`). */
  mode: number;
  /** sha256 of a file's bytes. */
  sha256?: string;
  /** A symlink's own target, unresolved. */
  target?: string;
}

export type TreeSnapshot = Record<string, SnapshotEntry>;

/**
 * Every path under `root`, relative, with its mode and content hash. Links
 * are recorded as links and never followed, so replacing a symlink with a
 * regular file of the same content is a difference.
 */
export function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(full);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        out[rel] = { type: "link", mode, target: readlinkSync(full) };
      } else if (stat.isDirectory()) {
        out[rel] = { type: "dir", mode };
        walk(full, rel);
      } else {
        out[rel] = {
          type: "file",
          mode,
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        };
      }
    }
  };
  walk(root, "");
  return out;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * What differs between two snapshots, ignoring every path at or under an
 * allowlisted prefix. The allowlist is explicit and documented at the call
 * site: a path that is not on it and differs fails the rig.
 */
export function diffTrees(
  before: TreeSnapshot,
  after: TreeSnapshot,
  allow: readonly string[] = [],
): TreeDiff {
  const allowed = (path: string) =>
    allow.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const diff: TreeDiff = { added: [], removed: [], changed: [] };
  for (const path of Object.keys(after)) {
    if (allowed(path)) continue;
    const was = before[path];
    const is = after[path] as SnapshotEntry;
    if (was === undefined) diff.added.push(path);
    else if (
      was.type !== is.type ||
      was.mode !== is.mode ||
      was.sha256 !== is.sha256 ||
      was.target !== is.target
    )
      diff.changed.push(path);
  }
  for (const path of Object.keys(before)) {
    if (allowed(path)) continue;
    if (after[path] === undefined) diff.removed.push(path);
  }
  return diff;
}

export const EMPTY_DIFF: TreeDiff = { added: [], removed: [], changed: [] };

function put(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** The user's own Claude Code settings: 4-space indent, hooks, env, other keys. */
export const USER_CLAUDE_SETTINGS = `{
    "model": "opus",
    "env": {
        "MY_TEAM_PROXY": "http://proxy.corp.example:8080",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel.corp.example:4318"
    },
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    { "type": "command", "command": "~/bin/audit-bash.sh" }
                ]
            }
        ]
    },
    "permissions": { "allow": ["Read"], "deny": [] }
}
`;

/** Tab-indented, no trailing newline: a file a re-serializer would rewrite. */
export const USER_CODEX_HOOKS =
  '{\n\t"hooks": {\n\t\t"Stop": [\n\t\t\t{ "hooks": [{ "type": "command", "command": "say done" }] }\n\t\t]\n\t}\n}';

/**
 * A Cursor hooks file the user already has, with their own hook and their own
 * `version`. The seed carried one of these for every harness but Cursor,
 * which is why nothing here exercised a Cursor file Tacho did not create, and
 * the one Cursor case the rig did cover was a file Tacho made from nothing.
 */
export const USER_CURSOR_HOOKS =
  '{\n  "version": 1,\n  "hooks": {\n    "afterFileEdit": [{ "command": "~/bin/my-format.sh" }]\n  }\n}\n';

export const USER_CODEX_CONFIG = `# my codex config
model = "gpt-5.1"
approval_policy = "on-request"

[mcp_servers.linear]
command = "npx"
args = ["-y", "linear-mcp"]
`;

export const USER_STELLA_TOML = `# stella, hand-edited
[model]
name = "fable-5"   # keep

[[hooks.PreToolUse]]
command = "~/bin/stella-audit.sh"`;

export const USER_CLAUDE_DESKTOP = `{
  "mcpServers": {
    "oxagen": { "command": "/usr/local/bin/my-own-oxagen-mcp", "args": ["--mine"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  },
  "globalShortcut": "Alt+Space"
}
`;

/** The three platforms with a user service manager: launchd, systemd, Task Scheduler. */
export type RigPlatform = "darwin" | "linux" | "win32";

export interface SeedOptions {
  /** Make `~/.claude/settings.json` a symlink into a dotfiles checkout. */
  symlinkedClaudeSettings?: boolean;
  platform?: RigPlatform;
  /**
   * Seed this directory instead of a fresh temporary one. It must be empty
   * or absent. The real service manager run on Linux uses a fixed path that
   * the user's systemd unit directory links to.
   */
  home?: string;
}

/**
 * What the fake service manager holds for one machine. It belongs to the
 * seed, not to a rig, so a rig built after another one died mid-install sees
 * the unit that one loaded or the task it registered, the way a real
 * `unenroll` run after a crash sees what the crashed `enroll` left.
 */
export interface RigMachine {
  /** The daemon is running (launchd and systemd: the unit is loaded). */
  loaded: boolean;
  /**
   * Windows: the tasks Task Scheduler holds. The task and the daemon are
   * apart there. The task's action is `cmd /c start`, which hands the daemon
   * off and returns, so ending the task leaves the daemon running and only
   * `taskkill` by pid stops it.
   */
  tasks: Set<string>;
  /** Windows: the daemon's pid while it runs. */
  daemonPid: number | undefined;
}

export interface RigHome {
  /** The scratch HOME. Everything the rig touches is under it. */
  home: string;
  platform: RigPlatform;
  /**
   * The machine's service manager state. `seedHome` always sets it. A rig
   * built from a home without one starts with nothing loaded.
   */
  machine?: RigMachine;
}

/** A service manager that holds nothing of Tacho's. */
function idleMachine(): RigMachine {
  return { loaded: false, tasks: new Set(), daemonPid: undefined };
}

/**
 * Where the rig's Claude Code and Stella read managed settings. Both are
 * under the scratch home, so a rig run never reads the managed settings of
 * the machine it runs on. Nothing is there unless a test writes it.
 */
export function rigManagedSettings(home: string): {
  claude: string;
  stella: string;
} {
  return {
    claude: join(home, "managed", "claude-code", "managed-settings.json"),
    stella: join(home, "managed", "stella", "stella.toml"),
  };
}

/**
 * Where Claude Desktop keeps its MCP config under the scratch HOME on
 * `platform`, relative to it. Undefined on Linux, where Anthropic ships no
 * build. The Windows path is `%APPDATA%`, which the rig leaves unset so it
 * falls back to `AppData/Roaming` under the home directory.
 */
export function rigClaudeDesktopConfig(
  platform: RigPlatform,
): string[] | undefined {
  if (platform === "darwin")
    return [
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ];
  if (platform === "win32")
    return ["AppData", "Roaming", "Claude", "claude_desktop_config.json"];
  return undefined;
}

/**
 * A scratch HOME that looks like a machine someone already uses: their own
 * Claude Code settings with hooks and env, a Codex config and hooks file, a
 * Stella config, a Claude Desktop MCP config that already has a server named
 * `oxagen`, a shell profile, an `oxagen` of their own on PATH, another
 * vendor's LaunchAgent, and the session `oxagen login` wrote.
 */
export function seedHome(options: SeedOptions = {}): RigHome {
  const platform = options.platform ?? "darwin";
  if (options.home !== undefined) mkdirSync(options.home, { recursive: true });
  // realpath: macOS hands out /var/… which is a link to /private/var/…
  const home = realpathSync(
    options.home ?? mkdtempSync(join(tmpdir(), "oxagen-rig-")),
  );
  if (options.symlinkedClaudeSettings === true) {
    put(join(home, "dotfiles", "claude-settings.json"), USER_CLAUDE_SETTINGS);
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(
      join("..", "dotfiles", "claude-settings.json"),
      join(home, ".claude", "settings.json"),
    );
  } else {
    put(join(home, ".claude", "settings.json"), USER_CLAUDE_SETTINGS);
  }
  put(join(home, ".claude", "CLAUDE.md"), "# my rules\n");
  put(join(home, ".codex", "config.toml"), USER_CODEX_CONFIG, 0o600);
  put(join(home, ".codex", "hooks.json"), USER_CODEX_HOOKS);
  put(join(home, ".cursor", "hooks.json"), USER_CURSOR_HOOKS);
  put(join(home, ".stella", "stella.toml"), USER_STELLA_TOML);
  const desktopConfig = rigClaudeDesktopConfig(platform);
  if (desktopConfig !== undefined)
    put(join(home, ...desktopConfig), USER_CLAUDE_DESKTOP);
  if (platform === "darwin") {
    put(
      join(home, "Library", "LaunchAgents", "com.example.other.plist"),
      "<plist/>\n",
    );
  } else if (platform === "win32") {
    // Another vendor's per-user program, so the snapshot covers a
    // `%LOCALAPPDATA%` Tacho has no business touching.
    put(
      join(home, "AppData", "Local", "Programs", "other", "other.exe"),
      "MZ\n",
      0o755,
    );
  } else {
    put(
      join(home, ".config", "systemd", "user", "other.service"),
      "[Unit]\nDescription=someone else's\n",
    );
  }
  put(
    join(home, ".zprofile"),
    'export EDITOR=vim\nexport PATH="$HOME/bin:$PATH"\n',
  );
  put(
    join(home, ".local", "bin", "oxagen"),
    "#!/bin/sh\necho my own oxagen\n",
    0o755,
  );
  put(
    join(home, ".config", "oxagen", "config.json"),
    `${JSON.stringify(
      {
        token: "oxa_session_token",
        orgSlug: "acme",
        workspaceSlug: "core",
        apiUrl: "https://api.rig.test",
        appUrl: "https://app.rig.test",
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  return { home, platform, machine: idleMachine() };
}

function enrollmentResponse(
  signer: ReturnType<typeof bundleSigner>,
): EnrollmentResponse {
  const bundle = signer.sign(unsignedBundle({ mode: "observe" }));
  return {
    hostEnrollmentId: TEST_ENROLLMENT,
    agentKey: "acme.core.cc-laptop",
    apiKeyPublicId: "key_1",
    apiKey: "oxk_host_secret",
    enrollment: {
      claims: {
        schema: "oxagen.tacho.host-enrollment.v1",
        issuer: "oxagen",
        audience: "tacho-host",
        host_enrollment_id: TEST_ENROLLMENT,
        organization_id: "org_1",
        workspace_id: "wrk_1",
        agent_key: "acme.core.cc-laptop",
        ingest_endpoint: "https://api.rig.test/v1/tacho/events",
        bundle_endpoint: "https://api.rig.test/v1/tacho/bundle",
        commands_endpoint: "https://api.rig.test/v1/tacho/commands",
        credential_env: "OXAGEN_TACHO_HOST_KEY",
        device_key_fingerprint: "abc",
        harnesses: ["claude-code"],
        issued_at_unix_s: 1,
        expires_at_unix_s: 2,
      },
      signature_hex: "0".repeat(64),
      verification_secret_env: "TACHO_ENROLLMENT_SIGNING_SECRET",
    },
    policyBundle: bundle,
    bundlePublicKeyPem: signer.publicKeyPem,
    expiresAt: "2027-03-09T00:00:00.000Z",
  };
}

/** Thrown by an injected fault to stand in for the process dying right there. */
export class RigKill extends Error {
  constructor(where: string) {
    super(`rig: killed at ${where}`);
    this.name = "RigKill";
  }
}

export interface Rig {
  home: string;
  deps: CliDeps;
  /**
   * The Codex config this rig stands in for. Its `trusted` map is the only
   * place an enrollment's trust records live here, because Codex keeps them
   * in its own `config.toml` and writes them itself.
   */
  codexServer: FakeCodexAppServer;
  /** Every `exec` the CLI made, service manager calls included. */
  execs: Array<{ command: string; args: string[] }>;
  /** Every control-plane request. */
  requests: Array<{ url: string; body: unknown }>;
  lines: string[];
  errors: string[];
  /**
   * Whether the fake service manager still holds anything of Tacho's: the
   * unit loaded (launchd, systemd), or on Windows the scheduled task
   * registered or the daemon it started still running.
   */
  serviceLoaded: () => boolean;
  /** Windows only: the fake Task Scheduler's view. Empty elsewhere. */
  scheduler: () => { tasks: string[]; daemonPid: number | undefined };
  /** Make the control plane unreachable (offline unenroll). */
  setOffline: (offline: boolean) => void;
}

/** Where the process can be made to die: a port by name, or one exec. */
export type KillPoint =
  | "fetch"
  | "launchctl bootstrap"
  | "systemctl show-environment"
  | "systemctl daemon-reload"
  | "systemctl enable"
  | "systemctl restart"
  | "schtasks /Create"
  | "schtasks /Run"
  | "readCodexHooks"
  | "readCursorHooks"
  | "readStellaHooks"
  | "writeClaudeDesktopConfig"
  | "daemonGet";

export interface RigOptions {
  /** Replace individual ports. */
  overrides?: Partial<CliDeps>;
  /**
   * Die at this point. A real kill runs no `catch` and no `finally`, and
   * `enroll` catches some failures on purpose (a service that will not
   * install is a warning). So the death is sticky: from the kill point on,
   * every port throws, which is as close as an in-process test gets to
   * "nothing after this line touched the disk".
   */
  killAt?: KillPoint;
  /** Whether the daemon's model proxy reports itself listening (default true). */
  gatewayListening?: boolean;
  /** Called with every exec before it runs, to observe ordering. */
  onExec?: (command: string, args: string[]) => void;
  /**
   * Hand the service manager's commands (`launchctl`, `systemctl`,
   * `schtasks`, `tasklist`, `taskkill`) to the real one instead of the fake,
   * and have the unit or task start `daemonCommand` (#4317). Kill points
   * still fire before each command. The seed's platform must be the host's.
   * Only `install-rig-real.test.ts` sets this, on a CI runner, never on a
   * machine running a tachod of its own.
   */
  realServices?: { exec: Exec; daemonCommand: string[] };
}

/** The commands `realServices` hands to the operating system. */
const SERVICE_COMMANDS = new Set([
  "launchctl",
  "systemctl",
  "schtasks",
  "tasklist",
  "taskkill",
]);

/** The port the rig's fake model proxy reports. */
export const RIG_GATEWAY_PORT = 47124;

/** The pid the rig's fake Windows daemon runs as. */
export const RIG_DAEMON_PID = 4242;

/**
 * Where the rig's app bundle keeps `tacho`: inside `Oxagen.app` on macOS and
 * Linux, the per-user install under `%LOCALAPPDATA%/Programs` on Windows.
 */
function rigBinDir(home: string, platform: RigPlatform): string {
  return platform === "win32"
    ? join(home, "AppData", "Local", "Programs", "Oxagen")
    : join(home, "Applications", "Oxagen.app", "Contents", "MacOS");
}

/**
 * The real `defaultCliDeps` — real path resolution, real file writers, the
 * real launchd / systemd manager — with the four things that would reach
 * outside the scratch HOME replaced: `exec`, `fetch`, the daemon probe, and
 * `codex app-server`. The last one is a real child process: left alone it
 * spawns the machine's own Codex, which answers about the machine's own
 * hooks and writes its state directory into the scratch HOME, so the tree
 * this rig exists to compare is no longer Tacho's doing.
 */
export function buildRig(seed: RigHome, options: RigOptions = {}): Rig {
  const { home, platform } = seed;
  const execs: Rig["execs"] = [];
  const requests: Rig["requests"] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const signer = bundleSigner();
  const machine = seed.machine ?? idleMachine();
  const { tasks } = machine;
  let offline = false;
  let dead = false;
  /** Throw if already dead, and die here when this is the kill point. */
  const pulse = (point: string) => {
    if (dead) throw new RigKill(`${point} (already dead)`);
    if (options.killAt === point) {
      dead = true;
      throw new RigKill(point);
    }
  };
  const exec: Exec = (command, args) => {
    // Every systemctl call starts with `--user`, so its kill point is named
    // by the subcommand after it.
    const verb =
      command === "systemctl" && args[0] === "--user" ? args[1] : args[0];
    pulse(`${command} ${verb ?? ""}`.trim());
    options.onExec?.(command, args);
    execs.push({ command, args });
    if (options.realServices !== undefined && SERVICE_COMMANDS.has(command)) {
      const result = options.realServices.exec(command, args);
      // The fake daemon probe below answers while the unit is up, so it
      // follows what the real service manager was asked to do.
      if (result.status === 0) {
        if (["bootstrap", "enable", "/Run"].includes(verb ?? ""))
          machine.loaded = true;
        if (["bootout", "disable", "/Delete"].includes(verb ?? ""))
          machine.loaded = false;
      }
      return result;
    }
    if (command === "launchctl") {
      if (args[0] === "bootstrap") machine.loaded = true;
      if (args[0] === "bootout") {
        const was = machine.loaded;
        machine.loaded = false;
        // launchctl answers 3 ("No such process") for a label not loaded.
        return { status: was ? 0 : 3, stdout: "", stderr: "" };
      }
      if (args[0] === "print")
        return {
          status: machine.loaded ? 0 : 113,
          stdout: machine.loaded ? "state = running\n" : "",
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "schtasks") return schtasks(args);
    if (command === "tasklist") {
      const filter = args[args.indexOf("/FI") + 1] ?? "";
      const pid = Number(/PID eq (\d+)/.exec(filter)?.[1]);
      return pid === machine.daemonPid
        ? {
            status: 0,
            stdout: `"tacho.exe","${pid}","Console","1","12,345 K"\r\n`,
            stderr: "",
          }
        : {
            status: 0,
            stdout:
              "INFO: No tasks are running which match the specified criteria.\r\n",
            stderr: "",
          };
    }
    if (command === "taskkill") {
      const pid = Number(args[args.indexOf("/PID") + 1]);
      if (pid !== machine.daemonPid)
        return {
          status: 128,
          stdout: "",
          stderr: `ERROR: The process "${pid}" not found.\r\n`,
        };
      // Killed with /F: it runs no exit handler, so its pid file stays.
      machine.daemonPid = undefined;
      machine.loaded = false;
      return { status: 0, stdout: "SUCCESS\r\n", stderr: "" };
    }
    if (command === "systemctl") {
      if (args.includes("enable")) machine.loaded = true;
      if (args.includes("disable")) machine.loaded = false;
      if (args.includes("is-active"))
        return {
          status: machine.loaded ? 0 : 3,
          stdout: machine.loaded ? "active\n" : "inactive\n",
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--version")
      return { status: 0, stdout: "2.1.263\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
  /**
   * Task Scheduler: `/Create` registers, `/Run` starts the launcher, whose
   * daemon writes its pid file, `/End` ends the task instance only, and
   * `/Delete` unregisters. A task it does not hold answers the way
   * `schtasks` does, status 1 and "cannot find".
   */
  function schtasks(args: string[]): ReturnType<Exec> {
    const name = args[args.indexOf("/TN") + 1] ?? "";
    const ok = { status: 0, stdout: "SUCCESS\r\n", stderr: "" };
    const missing = {
      status: 1,
      stdout: "",
      stderr: "ERROR: The system cannot find the file specified.\r\n",
    };
    switch (args[0]) {
      case "/Create":
        tasks.add(name);
        return ok;
      case "/Run":
        if (!tasks.has(name)) return missing;
        machine.daemonPid = RIG_DAEMON_PID;
        machine.loaded = true;
        writeFileSync(
          real.paths.pid,
          formatDaemonPid({
            pid: RIG_DAEMON_PID,
            started_at: "2026-09-18T12:00:00.000Z",
            exe: tacho,
          }),
        );
        return ok;
      case "/End":
        return tasks.has(name) ? ok : missing;
      case "/Delete":
        return tasks.delete(name) ? ok : missing;
      case "/Query":
        return tasks.has(name)
          ? {
              status: 0,
              stdout: `TaskName: \\${name}\r\nStatus: Ready\r\n`,
              stderr: "",
            }
          : missing;
      default:
        return missing;
    }
  }
  const fetch: FetchLike = async (url, init) => {
    pulse("fetch");
    if (offline) throw new Error("getaddrinfo ENOTFOUND api.rig.test");
    requests.push({ url, body: JSON.parse(init.body ?? "{}") });
    if (url.endsWith("/tacho/enrollments"))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(enrollmentResponse(signer)),
      };
    if (url.endsWith("/tacho/enrollments/revoke"))
      return { ok: true, status: 200, text: async () => "{}" };
    return { ok: false, status: 404, text: async () => "no" };
  };
  const bin = rigBinDir(home, platform);
  const tacho = join(bin, platform === "win32" ? "tacho.exe" : "tacho");
  // Windows quotes a command-line path with double quotes, the others with single.
  const quoted = platform === "win32" ? `"${tacho}"` : `'${tacho}'`;
  const real = defaultCliDeps(
    {
      home,
      env:
        platform === "win32"
          ? { USERPROFILE: home, HOME: home, PATH: "C:\\Windows\\System32" }
          : {
              HOME: home,
              PATH: "/usr/bin:/bin",
              SHELL: "/bin/zsh",
            },
      platform,
      exec,
      fetch,
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      now: () => Date.parse("2026-09-18T12:00:00.000Z"),
      hostname: "rig-laptop",
      osUser: "dev",
      claude: () => ({ path: "/usr/local/bin/claude", version: "2.1.263" }),
      codex: () => ({ path: "/usr/local/bin/codex", version: "0.104.0" }),
      cursor: () => ({
        path: "/usr/local/bin/cursor-agent",
        version: "2026.09.16",
      }),
      stella: () => ({ path: "/usr/local/bin/stella", version: "0.9.423" }),
      claudeDesktop: () => ({
        installed: true,
        path: "/Applications/Claude.app",
      }),
      runtime: {
        hookCommand: `${quoted} hook`,
        credentialHelperCommand: `${quoted} credential issue --harness claude-code`,
        daemonCommand: options.realServices?.daemonCommand ?? [tacho, "daemon"],
        mcpStdioCommand: [tacho, "mcp-stdio"],
        binDir: bin,
      },
      daemonGet: async (path) =>
        machine.loaded && path === "/status"
          ? {
              uptime_s: 1,
              spool_depth: 0,
              last_control_at: "2026-01-01T00:00:00.000Z",
              last_ingest_at: null,
              last_error: null,
            }
          : machine.loaded && path === "/health"
            ? {
                ok: true,
                gateway: {
                  listening: options.gatewayListening !== false,
                  port: RIG_GATEWAY_PORT,
                  routes: ["/anthropic", "/backend-api/codex"],
                  calls_observed: 0,
                },
              }
            : undefined,
      findFreePort: async () => 47123,
      randomToken: () => "local-token-0123456789abcdef",
      sleep: async () => undefined,
      wrapperVersion: TACHO_VERSION,
      ...options.overrides,
    },
    rigManagedSettings(home),
  );
  const codexServer = fakeCodexAppServer(real.paths.codexHooks);
  const guarded =
    <A extends unknown[], R>(point: string, port: (...args: A) => R) =>
    (...args: A): R => {
      pulse(point);
      return port(...args);
    };
  const deps: CliDeps = {
    ...real,
    readSettings: guarded("readSettings", real.readSettings),
    writeSettings: guarded("writeSettings", real.writeSettings),
    readCodexHooks: guarded("readCodexHooks", real.readCodexHooks),
    writeCodexHooks: guarded("writeCodexHooks", real.writeCodexHooks),
    readCursorHooks: guarded("readCursorHooks", real.readCursorHooks),
    writeCursorHooks: guarded("writeCursorHooks", real.writeCursorHooks),
    readStellaHooks: guarded("readStellaHooks", real.readStellaHooks),
    writeStellaHooks: guarded("writeStellaHooks", real.writeStellaHooks),
    readClaudeDesktopConfig: guarded(
      "readClaudeDesktopConfig",
      real.readClaudeDesktopConfig,
    ),
    writeClaudeDesktopConfig: guarded(
      "writeClaudeDesktopConfig",
      real.writeClaudeDesktopConfig,
    ),
    daemonGet: guarded("daemonGet", real.daemonGet),
    codexAppServer: guarded("codexAppServer", codexServer.server),
  };
  return {
    home,
    deps,
    codexServer,
    execs,
    requests,
    lines,
    errors,
    serviceLoaded: () => machine.loaded || tasks.size > 0,
    scheduler: () => ({ tasks: [...tasks], daemonPid: machine.daemonPid }),
    setOffline: (value) => {
      offline = value;
    },
  };
}
