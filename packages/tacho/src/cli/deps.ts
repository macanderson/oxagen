/**
 * The ports the `tacho` CLI commands run against. `defaultCliDeps()` binds
 * them to the real machine; tests hand in fakes and a scratch `TACHO_HOME`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import {
  arch as osArch,
  homedir,
  hostname as osHostname,
  release,
  userInfo,
} from "node:os";
import { createRequire } from "node:module";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../host/control-client";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile } from "../host/host-file";
import { oxagenConfigPath, type TachoPaths, tachoPaths } from "../host/paths";
import {
  type Exec,
  type ServiceManager,
  serviceManagerFor,
} from "../host/service";

export interface Credentials {
  token: string;
  org: string;
  workspace: string;
  apiUrl: string;
}

export interface CredentialOptions {
  token?: string;
  org?: string;
  workspace?: string;
  apiUrl?: string;
}

/**
 * Credentials come from flags, then `OXAGEN_*` env, then the CLI's own
 * `~/.config/oxagen/config.json` that `oxagen login` writes.
 */
function configPicker(
  env: Record<string, string | undefined>,
  home: string,
): (
  flag: string | undefined,
  envKey: string,
  configKey: string,
) => string | undefined {
  const config = (readJsonFileIfExists(oxagenConfigPath(home)) ?? {}) as Record<
    string,
    unknown
  >;
  return (flag, envKey, configKey) =>
    flag ??
    env[envKey] ??
    (typeof config[configKey] === "string"
      ? (config[configKey] as string)
      : undefined);
}

/** The control plane's base URL: the flag, then `OXAGEN_API_URL`, then the CLI config, then production. */
export function resolveApiUrl(
  options: Pick<CredentialOptions, "apiUrl">,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const pick = configPicker(env, home);
  return (
    pick(options.apiUrl, "OXAGEN_API_URL", "apiUrl") ?? "https://api.oxagen.sh"
  ).replace(/\/+$/, "");
}

export function resolveCredentials(
  options: CredentialOptions,
  env: Record<string, string | undefined>,
  home: string,
): { credentials: Credentials } | { missing: string[] } {
  const pick = configPicker(env, home);
  const token = pick(options.token, "OXAGEN_API_TOKEN", "token");
  const org = pick(options.org, "OXAGEN_ORG_ID", "orgSlug");
  const workspace = pick(
    options.workspace,
    "OXAGEN_WORKSPACE_ID",
    "workspaceSlug",
  );
  const missing: string[] = [];
  if (token === undefined) missing.push("--token (or `oxagen login`)");
  if (org === undefined) missing.push("--org");
  if (workspace === undefined) missing.push("--workspace");
  if (missing.length > 0) return { missing };
  return {
    credentials: {
      token: token as string,
      org: org as string,
      workspace: workspace as string,
      apiUrl: resolveApiUrl(options, env, home),
    },
  };
}

export interface RuntimeCommands {
  /** Shell command line that runs `tacho-hook`. */
  hookCommand: string;
  /** argv that runs `tachod` in the foreground. */
  daemonCommand: string[];
  /** Where the executables live, for `status`. */
  binDir: string;
  /**
   * Set when `binDir` exists only for this launch — see `transientBinDir`.
   * `enroll` refuses rather than bake it into the hooks and the service.
   */
  transient?: string;
}

/**
 * Why `binDir` will not survive the running process, or undefined when it
 * will. A per-launch AppImage mount (`/tmp/.mount_*`, `APPIMAGE` set), a
 * macOS disk image (`/Volumes/*`) and an App-Translocated app (a
 * quarantined bundle opened where it was downloaded) all give the sidecar
 * an exec path that is gone when the app quits — a hook command or a
 * service `ExecStart` pointing there fails to spawn from then on, while
 * host.json and the fleet page still say enrolled.
 */
export function transientBinDir(
  binDir: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const posixDir = binDir.replace(/\\/g, "/");
  if (posixDir.startsWith("/tmp/.mount_")) return "an AppImage mount";
  if (/\/AppTranslocation\//.test(posixDir))
    return "App Translocation (the app was opened where it was downloaded)";
  if (posixDir.startsWith("/Volumes/")) return "a mounted disk image";
  if (env["TACHO_BIN_DIR"] === undefined && env["APPIMAGE"] !== undefined)
    return "an AppImage mount";
  return undefined;
}

export function shellQuote(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  // Claude Code and Codex hand command hooks to cmd.exe on Windows, where
  // double quotes are the only quoting and a `"` inside a path cannot occur.
  if (platform === "win32") return `"${value}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** True when this process is a compiled single-executable (Node SEA) build. */
export function isNativeBuild(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as {
      isSea?: () => boolean;
    };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

function exeName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

/**
 * Locate the executables the hooks and the service run. Three layouts:
 *
 *   - native: one compiled, multi-call `tacho` binary (a Tauri sidecar or a
 *     Homebrew install); the hook is `tacho hook`, the daemon `tacho daemon`;
 *     no `node` on the machine is assumed;
 *   - bundle: `tacho.mjs` next to `tachod.mjs` and `tacho-hook.mjs`, run by
 *     the current `node`;
 *   - source: the `bin/` shims that load TypeScript through tsx.
 *
 * `TACHO_BIN_DIR` overrides the directory; the layout is still detected from
 * what is in it, so the desktop app can point at its own resources.
 */
export function runtimeCommands(
  entry: string | undefined = process.argv[1],
  env: Record<string, string | undefined> = process.env,
  nodePath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  native: boolean = isNativeBuild(),
): RuntimeCommands {
  // Path flavour follows the target platform, not the host, so a macOS test
  // can describe a Windows layout.
  const P = platform === "win32" ? win32 : posix;
  let binDir = env["TACHO_BIN_DIR"];
  if (binDir === undefined) {
    if (native) {
      binDir = P.dirname(nodePath);
    } else {
      const here = dirname(fileURLToPath(import.meta.url));
      const entryDir =
        entry !== undefined ? P.dirname(P.resolve(entry)) : undefined;
      if (entryDir !== undefined && existsSync(P.join(entryDir, "tachod.mjs")))
        binDir = entryDir;
      else binDir = resolve(here, "..", "..", "bin");
    }
  }
  const nativeTacho = P.join(binDir, exeName("tacho", platform));
  const nativeLayout =
    native ||
    (existsSync(nativeTacho) && !existsSync(P.join(binDir, "tachod.mjs")));
  const transient = transientBinDir(binDir, env);
  const flagged = transient !== undefined ? { transient } : {};
  if (nativeLayout) {
    return {
      hookCommand: `${shellQuote(nativeTacho, platform)} hook`,
      daemonCommand: [nativeTacho, "daemon"],
      binDir,
      ...flagged,
    };
  }
  return {
    hookCommand: `${shellQuote(nodePath, platform)} ${shellQuote(P.join(binDir, "tacho-hook.mjs"), platform)}`,
    daemonCommand: [nodePath, P.join(binDir, "tachod.mjs")],
    binDir,
    ...flagged,
  };
}

export interface ClaudeFacts {
  path?: string;
  version?: string;
}

/** What `enroll` records about an installed harness executable. */
export type HarnessFacts = ClaudeFacts;

export interface CliDeps {
  paths: TachoPaths;
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  fetch: FetchLike;
  exec: Exec;
  serviceManager: ServiceManager;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  hostname: string;
  osUser: string;
  osVersion: string;
  arch: string;
  nodeVersion: string;
  readSettings: () => unknown;
  writeSettings: (document: unknown) => void;
  /** Codex CLI's `hooks.json`, undefined when absent. */
  readCodexHooks: () => unknown;
  writeCodexHooks: (document: unknown) => void;
  claude: () => ClaudeFacts;
  codex: () => HarnessFacts;
  runtime: RuntimeCommands;
  /** GET a daemon route on the loopback port with the local bearer. */
  daemonGet: (path: string) => Promise<unknown | undefined>;
  findFreePort: () => Promise<number>;
  randomToken: () => string;
  sleep: (ms: number) => Promise<void>;
  wrapperVersion: string;
}

/** Nothing the CLI shells out to for a fact may take longer than this. */
export const EXEC_TIMEOUT_MS = 10_000;

function realExec(command: string, args: string[]): ReturnType<Exec> {
  // stdin is closed, never inherited: a probe must not wait on the parent
  // (the desktop app keeps its sidecar's stdin pipe open for the process
  // lifetime), and the timeout turns a shell profile that prompts or hangs
  // into "not found" instead of a scan that never ends.
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: EXEC_TIMEOUT_MS,
  });
  return {
    status: result.error !== undefined ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error?.message ?? ""),
  };
}

/**
 * Where the harness installers put their binaries, checked directly when
 * no shell reports them. The desktop app launches from Finder with the bare
 * system PATH, and Claude Code adds its `~/.local/bin` line to `.zshrc`,
 * which no non-interactive shell reads.
 */
export function wellKnownBinDirs(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): string[] {
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? `${home}\\AppData\\Roaming`;
    const local = env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`;
    return [
      `${appData}\\npm`,
      `${local}\\Programs\\claude`,
      `${home}\\.local\\bin`,
      `${home}\\.codex\\bin`,
    ];
  }
  return [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.codex/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
  ];
}

function firstLine(result: ReturnType<Exec>): string | undefined {
  if (result.status !== 0) return undefined;
  const line = (
    result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ""
  ).trim();
  return line.length > 0 ? line : undefined;
}

/**
 * Find a harness executable and read its version. On POSIX the lookup asks
 * the user's own login shell (`$SHELL -lc`: `.zprofile` / `.bash_profile`,
 * where Homebrew and nvm put their PATH lines), then `sh -lc`, then the
 * well-known install directories on disk (`~/.local/bin`, where Claude Code
 * lives and whose PATH line sits in `.zshrc`); `where` on Windows. Never an
 * interactive shell: `-i` runs prompt frameworks and completion setup that
 * take seconds or wait on a terminal. Every probe runs under
 * `EXEC_TIMEOUT_MS` with stdin closed (see `realExec`).
 */
export function harnessFacts(
  exec: Exec,
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = env["HOME"] ?? env["USERPROFILE"] ?? "",
): HarnessFacts {
  let path: string | undefined;
  if (platform === "win32") {
    path = firstLine(exec("where", [name]));
  } else {
    const shell = env["SHELL"];
    if (shell !== undefined && shell.length > 0 && shell !== "/bin/sh")
      path = firstLine(exec(shell, ["-lc", `command -v ${name}`]));
    path ??= firstLine(exec("sh", ["-lc", `command -v ${name}`]));
  }
  if (path === undefined) {
    const sep = platform === "win32" ? "\\" : "/";
    const names =
      platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
    outer: for (const dir of wellKnownBinDirs(home, platform, env)) {
      for (const file of names) {
        const candidate = `${dir}${sep}${file}`;
        if (existsSync(candidate)) {
          path = candidate;
          break outer;
        }
      }
    }
  }
  if (path === undefined) return {};
  const version = exec(path, ["--version"]);
  const match = /(\d+\.\d+\.\d+)/.exec(version.stdout);
  return { path, ...(match?.[1] !== undefined ? { version: match[1] } : {}) };
}

export function claudeFacts(
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home?: string,
): ClaudeFacts {
  return harnessFacts(exec, "claude", platform, env, home);
}

export function defaultCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  const paths = overrides.paths ?? tachoPaths(env, home);
  const exec = overrides.exec ?? realExec;
  const platform = overrides.platform ?? process.platform;
  const daemonGet = async (path: string): Promise<unknown | undefined> => {
    const host = readHostFile(paths.hostFile);
    if (host === undefined) return undefined;
    return new Promise((resolvePromise) => {
      const req = httpGet(
        {
          host: "127.0.0.1",
          port: host.port,
          path,
          headers: { Authorization: `Bearer ${host.local_token}` },
          timeout: 2_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              resolvePromise(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
            } catch {
              resolvePromise(undefined);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolvePromise(undefined));
    });
  };
  return {
    paths,
    env,
    home,
    platform,
    fetch: (input, init) => fetch(input, init) as never,
    exec,
    serviceManager: serviceManagerFor({
      platform,
      home,
      exec,
      launcherPath: paths.daemonLauncher,
      pidPath: paths.pid,
    }),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    hostname: osHostname(),
    osUser: userInfo().username,
    osVersion: release(),
    arch: osArch(),
    nodeVersion: process.version,
    readSettings: () => readJsonFileIfExists(paths.claudeSettings),
    writeSettings: (document) =>
      writeSensitiveFileAtomic(
        paths.claudeSettings,
        `${JSON.stringify(document, null, 2)}\n`,
        0o644,
      ),
    readCodexHooks: () => readJsonFileIfExists(paths.codexHooks),
    writeCodexHooks: (document) =>
      writeSensitiveFileAtomic(
        paths.codexHooks,
        `${JSON.stringify(document, null, 2)}\n`,
        0o644,
      ),
    claude: () => claudeFacts(exec, platform, env, home),
    codex: () => harnessFacts(exec, "codex", platform, env, home),
    runtime: runtimeCommands(undefined, env, undefined, platform),
    daemonGet,
    findFreePort: () =>
      new Promise((resolvePromise, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port =
            typeof address === "object" && address !== null ? address.port : 0;
          server.close(() => resolvePromise(port));
        });
      }),
    randomToken: () => randomBytes(24).toString("hex"),
    sleep: (ms) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    wrapperVersion: packageVersion(),
    ...overrides,
  };
}

/** Stamped by `scripts/bundle.mjs`; undefined when running from source. */
declare const __TACHO_VERSION__: string | undefined;

function packageVersion(): string {
  if (typeof __TACHO_VERSION__ === "string") return __TACHO_VERSION__;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
