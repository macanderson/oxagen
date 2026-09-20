/**
 * The install and uninstall rig: a scratch HOME seeded the way a real
 * developer's machine looks, a fake `launchctl` / `systemctl`, a fake control
 * plane, and a tree snapshot (paths, modes, content hashes, link targets).
 *
 * Nothing here touches the real home directory, the real LaunchAgents or a
 * real service manager: every path hangs off a `mkdtemp` directory and every
 * process the CLI would spawn goes through the `exec` fake. The suite in
 * `install-rig.test.ts` and the desktop script
 * `apps/desktop/scripts/install-rig.mjs` both drive it.
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
import type { Exec } from "../host/service";
import {
  bundleSigner,
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

export interface SeedOptions {
  /** Make `~/.claude/settings.json` a symlink into a dotfiles checkout. */
  symlinkedClaudeSettings?: boolean;
  platform?: "darwin" | "linux";
}

export interface RigHome {
  /** The scratch HOME. Everything the rig touches is under it. */
  home: string;
  platform: "darwin" | "linux";
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
  // realpath: macOS hands out /var/… which is a link to /private/var/…
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oxagen-rig-")));
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
  if (platform === "darwin") {
    put(
      join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
      USER_CLAUDE_DESKTOP,
    );
    put(
      join(home, "Library", "LaunchAgents", "com.example.other.plist"),
      "<plist/>\n",
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
  return { home, platform };
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
  /** Every `exec` the CLI made, service manager calls included. */
  execs: Array<{ command: string; args: string[] }>;
  /** Every control-plane request. */
  requests: Array<{ url: string; body: unknown }>;
  lines: string[];
  errors: string[];
  /** Whether the fake service manager currently has the unit loaded. */
  serviceLoaded: () => boolean;
  /** Make the control plane unreachable (offline unenroll). */
  setOffline: (offline: boolean) => void;
}

/** Where the process can be made to die: a port by name, or one exec. */
export type KillPoint =
  | "fetch"
  | "launchctl bootstrap"
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
}

/** The port the rig's fake model proxy reports. */
export const RIG_GATEWAY_PORT = 47124;

/**
 * The real `defaultCliDeps` — real path resolution, real file writers, the
 * real launchd / systemd manager — with the three things that would reach
 * outside the scratch HOME replaced: `exec`, `fetch` and the daemon probe.
 */
export function buildRig(seed: RigHome, options: RigOptions = {}): Rig {
  const { home, platform } = seed;
  const execs: Rig["execs"] = [];
  const requests: Rig["requests"] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const signer = bundleSigner();
  let loaded = false;
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
    pulse(`${command} ${args[0] ?? ""}`.trim());
    options.onExec?.(command, args);
    execs.push({ command, args });
    if (command === "launchctl") {
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") {
        const was = loaded;
        loaded = false;
        // launchctl answers 3 ("No such process") for a label not loaded.
        return { status: was ? 0 : 3, stdout: "", stderr: "" };
      }
      if (args[0] === "print")
        return {
          status: loaded ? 0 : 113,
          stdout: loaded ? "state = running\n" : "",
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "systemctl") {
      if (args.includes("enable")) loaded = true;
      if (args.includes("disable")) loaded = false;
      if (args.includes("is-active"))
        return {
          status: loaded ? 0 : 3,
          stdout: loaded ? "active\n" : "inactive\n",
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--version")
      return { status: 0, stdout: "2.1.263\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
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
  const bin = join(home, "Applications", "Oxagen.app", "Contents", "MacOS");
  const real = defaultCliDeps({
    home,
    env: {
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
      hookCommand: `'${join(bin, "tacho")}' hook`,
      daemonCommand: [join(bin, "tacho"), "daemon"],
      mcpStdioCommand: [join(bin, "tacho"), "mcp-stdio"],
      binDir: bin,
    },
    daemonGet: async (path) =>
      loaded && path === "/health"
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
  });
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
  };
  return {
    home,
    deps,
    execs,
    requests,
    lines,
    errors,
    serviceLoaded: () => loaded,
    setOffline: (value) => {
      offline = value;
    },
  };
}
