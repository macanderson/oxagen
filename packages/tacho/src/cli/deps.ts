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
export function resolveCredentials(
  options: CredentialOptions,
  env: Record<string, string | undefined>,
  home: string,
): { credentials: Credentials } | { missing: string[] } {
  const config = (readJsonFileIfExists(oxagenConfigPath(home)) ?? {}) as Record<
    string,
    unknown
  >;
  const pick = (
    flag: string | undefined,
    envKey: string,
    configKey: string,
  ): string | undefined =>
    flag ??
    env[envKey] ??
    (typeof config[configKey] === "string"
      ? (config[configKey] as string)
      : undefined);
  const token = pick(options.token, "OXAGEN_API_TOKEN", "token");
  const org = pick(options.org, "OXAGEN_ORG_ID", "orgSlug");
  const workspace = pick(
    options.workspace,
    "OXAGEN_WORKSPACE_ID",
    "workspaceSlug",
  );
  const apiUrl =
    pick(options.apiUrl, "OXAGEN_API_URL", "apiUrl") ?? "https://api.oxagen.sh";
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
      apiUrl: apiUrl.replace(/\/+$/, ""),
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
 * Locate the sibling executables. Three layouts exist:
 *
 *   - native: the compiled `tacho` binary (a Tauri sidecar or a Homebrew
 *     install) sits next to compiled `tachod` and `tacho-hook`; no `node`;
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
  const nativeHook = P.join(binDir, exeName("tacho-hook", platform));
  const nativeDaemon = P.join(binDir, exeName("tachod", platform));
  if (native || existsSync(nativeDaemon)) {
    return {
      hookCommand: shellQuote(nativeHook, platform),
      daemonCommand: [nativeDaemon],
      binDir,
    };
  }
  return {
    hookCommand: `${shellQuote(nodePath, platform)} ${shellQuote(P.join(binDir, "tacho-hook.mjs"), platform)}`,
    daemonCommand: [nodePath, P.join(binDir, "tachod.mjs")],
    binDir,
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

function realExec(command: string, args: string[]): ReturnType<Exec> {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Find a harness executable on PATH and read its version. `sh -lc` on POSIX
 * so a login-shell PATH (nvm, Homebrew) is honoured; `where` on Windows,
 * whose first line is the first match.
 */
export function harnessFacts(
  exec: Exec,
  name: string,
  platform: NodeJS.Platform = process.platform,
): HarnessFacts {
  const which =
    platform === "win32"
      ? exec("where", [name])
      : exec("sh", ["-lc", `command -v ${name}`]);
  const path =
    which.status === 0
      ? (which.stdout.split(/\r?\n/)[0] ?? "").trim()
      : undefined;
  if (path === undefined || path.length === 0) return {};
  const version = exec(path, ["--version"]);
  const match = /(\d+\.\d+\.\d+)/.exec(version.stdout);
  return { path, ...(match?.[1] !== undefined ? { version: match[1] } : {}) };
}

export function claudeFacts(
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
): ClaudeFacts {
  return harnessFacts(exec, "claude", platform);
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
    claude: () => claudeFacts(exec, platform),
    codex: () => harnessFacts(exec, "codex", platform),
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

function packageVersion(): string {
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
