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
import { dirname, join, resolve } from "node:path";
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

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Locate the sibling executables. From the published bundle they sit next
 * to the running `tacho.mjs`; from the source tree they are the `bin/`
 * shims that load TypeScript through tsx. `TACHO_BIN_DIR` overrides both.
 */
export function runtimeCommands(
  entry: string | undefined = process.argv[1],
  env: Record<string, string | undefined> = process.env,
  nodePath: string = process.execPath,
): RuntimeCommands {
  const here = dirname(fileURLToPath(import.meta.url));
  let binDir = env["TACHO_BIN_DIR"];
  if (binDir === undefined) {
    const entryDir = entry !== undefined ? dirname(resolve(entry)) : undefined;
    if (entryDir !== undefined && existsSync(join(entryDir, "tachod.mjs")))
      binDir = entryDir;
    else binDir = resolve(here, "..", "..", "bin");
  }
  return {
    hookCommand: `${shellQuote(nodePath)} ${shellQuote(join(binDir, "tacho-hook.mjs"))}`,
    daemonCommand: [nodePath, join(binDir, "tachod.mjs")],
    binDir,
  };
}

export interface ClaudeFacts {
  path?: string;
  version?: string;
}

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
  claude: () => ClaudeFacts;
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

export function claudeFacts(exec: Exec): ClaudeFacts {
  const which = exec("sh", ["-lc", "command -v claude"]);
  const path = which.status === 0 ? which.stdout.trim() : undefined;
  if (path === undefined || path.length === 0) return {};
  const version = exec(path, ["--version"]);
  const match = /(\d+\.\d+\.\d+)/.exec(version.stdout);
  return { path, ...(match?.[1] !== undefined ? { version: match[1] } : {}) };
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
    serviceManager: serviceManagerFor({ platform, home, exec }),
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
    claude: () => claudeFacts(exec),
    runtime: runtimeCommands(),
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
