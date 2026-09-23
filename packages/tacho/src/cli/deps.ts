/**
 * The ports the `tacho` CLI commands run against. `defaultCliDeps()` binds
 * them to the real machine; tests hand in fakes and a scratch `TACHO_HOME`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
import { postUnix } from "../claude-code/hook-client";
import {
  type CodexAppServer,
  codexAppServerClient,
} from "../host/codex-app-server";
import type { FetchLike } from "../host/control-client";
import {
  type CredentialStore,
  openCredentialStore,
} from "../host/credential-store";
import { readJsonFileIfExists } from "../host/fs";
import { HarnessFiles, type SettleOutcome } from "../host/harness-file";
import { readHostFile } from "../host/host-file";
import {
  applyModelBaseUrls,
  type ModelBaseUrlOptions,
  type ModelBaseUrlState,
  readModelBaseUrlState,
  restoreModelBaseUrls,
} from "../host/model-base-url";
import {
  applyModelCredentials,
  helperCommandFor,
  type ModelCredentialOptions,
  type ModelCredentialState,
  peekModelCredentials,
  readModelCredentialState,
  type TakenCredential,
  type RestoreSecrets,
  restoreModelCredentials,
} from "../host/model-credential";
import {
  readStellaHooksFile,
  type StellaHooksFile,
  type StellaHooksFormat,
} from "../host/stella-writer";
import { oxagenConfigPath, type TachoPaths, tachoPaths } from "../host/paths";
import {
  type Exec,
  type ServiceManager,
  serviceManagerFor,
} from "../host/service";
import { TACHO_VERSION } from "../version";
import { HARNESS_BINARY } from "../wire";

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
  // A config.json that does not parse is "not logged in", not a crash: this
  // runs inside `unenroll`'s revoke, after the hooks and the service are
  // already gone, and a throw there stranded the credentials on disk.
  let config: Record<string, unknown> = {};
  try {
    const parsed = readJsonFileIfExists(oxagenConfigPath(home));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      config = parsed as Record<string, unknown>;
  } catch {
    config = {};
  }
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
  /**
   * Shell command line that runs `tacho credential issue --harness
   * claude-code`, which Claude Code runs as its `apiKeyHelper` on a brokered
   * host (ADR-143). Computed beside the hook command so it names the same
   * binary layout: a helper that outlives its executable leaves Claude Code
   * with no credential at all.
   */
  credentialHelperCommand: string;
  /** argv that runs `tachod` in the foreground. */
  daemonCommand: string[];
  /**
   * argv that runs the MCP stdio shim, for a connected app whose config file
   * spawns a process rather than dialling a URL (ADR-078). Computed here
   * beside the other two so all three reference the same binary layout: a
   * connected app's entry must not outlive the executable it names any more
   * than a hook may.
   */
  mcpStdioCommand: string[];
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
      credentialHelperCommand: helperCommandFor(
        shellQuote(nativeTacho, platform),
      ),
      daemonCommand: [nativeTacho, "daemon"],
      mcpStdioCommand: [nativeTacho, "mcp-stdio"],
      binDir,
      ...flagged,
    };
  }
  return {
    hookCommand: `${shellQuote(nodePath, platform)} ${shellQuote(P.join(binDir, "tacho-hook.mjs"), platform)}`,
    credentialHelperCommand: helperCommandFor(
      `${shellQuote(nodePath, platform)} ${shellQuote(P.join(binDir, "tacho.mjs"), platform)}`,
    ),
    daemonCommand: [nodePath, P.join(binDir, "tachod.mjs")],
    mcpStdioCommand: [nodePath, P.join(binDir, "tacho.mjs"), "mcp-stdio"],
    binDir,
    ...flagged,
  };
}

/**
 * What `detect` knows about an installed connected app. There is no version:
 * a GUI bundle does not answer `--version`, and reading its Info.plist for a
 * number nothing uses would be a fact collected because it was available.
 */
export interface AppFacts {
  installed: boolean;
  /** The bundle or install directory, when one was found. */
  path?: string;
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
  /**
   * The same port with a budget fit for a whole agent turn rather than a
   * fact probe. `exec` times out at `EXEC_TIMEOUT_MS`, which is right for
   * `command -v` and `--version` and wrong for the headless turn `verify`
   * drives: a harness that thinks for eleven seconds was being killed
   * mid-turn and reported as a failed verification.
   */
  execLong: Exec;
  /**
   * Drive `codex app-server` for one JSON-RPC exchange. Used to read hook
   * trust out of Codex and record it (`host/codex-hook-trust.ts`).
   */
  codexAppServer: CodexAppServer;
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
  /**
   * One of Cursor's `hooks.json` files (`paths.cursorHooks`), undefined when
   * absent. Keyed by path rather than fixed to one, because a moved config
   * directory means Oxagen writes two: see `host/cursor-writer.ts`.
   */
  readCursorHooks: (path: string) => unknown;
  /**
   * `vestigial` says the document holds nothing but the `version` the writer
   * added itself, so `settle` may take the whole file back. Only the
   * teardown passes it, and only when the strip left nothing of the user's
   * (`cursorDocumentIsVestigial`).
   */
  writeCursorHooks: (
    path: string,
    document: unknown,
    vestigial?: boolean,
  ) => void;
  /**
   * Stella's user-scope hooks file: `stella.toml` when it exists, else the
   * legacy `settings.json` when that exists, else a new `stella.toml`.
   * `format` reads that one file instead (unenroll strips both).
   */
  readStellaHooks: (format?: StellaHooksFormat) => StellaHooksFile;
  writeStellaHooks: (file: StellaHooksFile) => void;
  /**
   * Claude Desktop's MCP client config, undefined when the file is absent.
   * The writer is pure; these two are the only file I/O for the connected
   * tier, matching how the hook writers are fed.
   */
  readClaudeDesktopConfig: () => unknown;
  writeClaudeDesktopConfig: (document: unknown) => void;
  /**
   * Why a harness file could not be written (read-only, or in a read-only
   * directory), or undefined when it can. `enroll` asks before it mints
   * anything, so a file it cannot write is a refusal and not a half install.
   */
  harnessWriteProblem?: (path: string) => string | undefined;
  /**
   * Give every harness file back after the hooks are stripped: original
   * bytes and mode where the document says what it said before, a file and
   * directories enroll created removed when blank again. See
   * `host/harness-file.ts`. Optional so a test's in-memory ports need not
   * supply it.
   */
  settleHarnessFiles?: () => SettleOutcome[];
  /**
   * The model base URL contract (`host/model-base-url.ts`): point a harness
   * at the daemon's loopback model proxy, take that back out, or report it.
   * Optional so a test's in-memory ports need not supply it, in which case
   * no base URL is ever written.
   */
  modelBaseUrls?: {
    apply: (options: ModelBaseUrlOptions) => Promise<ModelBaseUrlState>;
    restore: (options: ModelBaseUrlOptions) => Promise<ModelBaseUrlState>;
    read: (options: ModelBaseUrlOptions) => Promise<ModelBaseUrlState>;
  };
  /**
   * The brokered credential contract (`host/model-credential.ts`, ADR-143):
   * take a harness's vendor key out of its file and point it at the
   * gateway's run tokens, put it back, or report it. Optional for the same
   * reason `modelBaseUrls` is, and absent means no credential is ever taken
   * into custody.
   */
  modelCredentials?: {
    /** The secrets apply would take, without writing; sealed before apply. */
    peek: (options: ModelCredentialOptions) => Promise<TakenCredential[]>;
    apply: (options: ModelCredentialOptions) => Promise<ModelCredentialState>;
    restore: (
      options: ModelCredentialOptions,
      restore: RestoreSecrets,
    ) => Promise<ModelCredentialState>;
    read: (options: ModelCredentialOptions) => Promise<ModelCredentialState>;
  };
  /** The gateway's custody of vendor credentials (`host/credential-store.ts`). */
  credentialStore?: CredentialStore;
  /**
   * POST to the daemon over its socket (loopback TCP on Windows) with the
   * local bearer, for `tacho credential issue`. Answers undefined when the
   * host is not enrolled or the daemon does not answer.
   */
  daemonPost?: (
    path: string,
    body: unknown,
  ) => Promise<{ status: number; body: string } | undefined>;
  claude: () => ClaudeFacts;
  codex: () => HarnessFacts;
  /**
   * Cursor, found by its `cursor-agent` alias on PATH and by the editor on
   * disk. Only the alias identifies the executable: a generic `agent` on PATH
   * belongs to unrelated software as often as not. The editor reads the same
   * `~/.cursor/hooks.json`, so a machine carrying it alone is wrapped all the
   * same, and `CursorFacts.app` is how that machine says so.
   */
  cursor: () => CursorFacts;
  stella: () => HarnessFacts;
  /**
   * Whether Claude Desktop is installed. A connected app is a GUI bundle, not
   * a binary on PATH, so it is detected by the app on disk rather than by
   * `command -v` and a `--version` probe.
   */
  claudeDesktop: () => AppFacts;
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

/**
 * How long a whole headless agent turn may take. `verify` runs one, and a
 * turn is a model round trip plus whatever tools it decides to call, so it
 * belongs nowhere near the budget for reading a `--version` string. Every
 * harness `verify` drives gives up on its own well before this; the bound is
 * only here so a harness that hangs cannot hang the CLI with it.
 */
export const EXEC_LONG_TIMEOUT_MS = 180_000;

function spawnCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): ReturnType<Exec> {
  // stdin is closed, never inherited: a probe must not wait on the parent
  // (the desktop app keeps its sidecar's stdin pipe open for the process
  // lifetime), and the timeout turns a shell profile that prompts or hangs
  // into "not found" instead of a scan that never ends.
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return {
    status: result.error !== undefined ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error?.message ?? ""),
  };
}

function realExec(command: string, args: string[]): ReturnType<Exec> {
  return spawnCapture(command, args, EXEC_TIMEOUT_MS);
}

function realExecLong(command: string, args: string[]): ReturnType<Exec> {
  return spawnCapture(command, args, EXEC_LONG_TIMEOUT_MS);
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
      `${home}\\.cargo\\bin`,
    ];
  }
  return [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.codex/bin`,
    // Stella installs through cargo as well as its install script.
    `${home}/.cargo/bin`,
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
  // The disk check for the well-known directories. Injected so a test is
  // not answered by whatever happens to be installed on the machine running
  // it (/opt/homebrew/bin and /usr/local/bin are absolute, not under home).
  exists: (candidate: string) => boolean = existsSync,
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
        if (exists(candidate)) {
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

/**
 * Where Claude Desktop installs itself, checked on disk. Verified 2026-09-16:
 * macOS puts an app bundle in `/Applications` (or `~/Applications` for a
 * per-user install); Windows installs per-user under `%LOCALAPPDATA%`. Linux
 * has no official build, so the answer there is "not installed" and the
 * enrollment refuses the harness rather than writing a file nothing reads.
 */
export function claudeDesktopFacts(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
  exists: (candidate: string) => boolean = existsSync,
): AppFacts {
  const candidates: string[] =
    platform === "darwin"
      ? ["/Applications/Claude.app", `${home}/Applications/Claude.app`]
      : platform === "win32"
        ? [
            `${env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`}\\AnthropicClaude`,
            `${env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`}\\Programs\\Claude`,
          ]
        : [];
  for (const candidate of candidates) {
    if (exists(candidate)) return { installed: true, path: candidate };
  }
  return { installed: false };
}

/** Only this alias identifies Cursor without trusting a generic executable name. */
export const CURSOR_CLI_NAMES = [HARNESS_BINARY.cursor] as const;

/**
 * What a Cursor probe found. `path` and `version` describe the `cursor-agent`
 * executable and nothing else, because `enroll` records them as
 * `cursor_execpath` and `cursor_version` in `host.json`. The editor is a
 * separate signal under `app`, so an application directory never reaches a
 * field that means "the binary we would run".
 */
export interface CursorFacts extends HarnessFacts {
  /** The Cursor editor on disk, when this platform documents where it lands. */
  app?: AppFacts;
}

/**
 * Where the Cursor editor installs itself, checked on disk. macOS ships an
 * application bundle in `/Applications` (or `~/Applications` for a per-user
 * install). Windows ships a per-user installer under `%LOCALAPPDATA%\Programs`
 * and a machine-wide one under `%PROGRAMFILES%`.
 *
 * Linux answers "not installed" on purpose. Cursor ships there as an AppImage
 * the person places wherever they like, so every path this could check would
 * be a guess, and a probe that names the wrong directory is worse than one
 * that says it does not know. A Linux machine with the editor alone is
 * covered through `coverableWhenAbsent` on the detect entry instead: the hooks
 * file governs Cursor whether or not anything was found here.
 */
export function cursorAppFacts(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
  exists: (candidate: string) => boolean = existsSync,
): AppFacts {
  const local = env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`;
  const programs = env["PROGRAMFILES"] ?? "C:\\Program Files";
  const candidates: string[] =
    platform === "darwin"
      ? ["/Applications/Cursor.app", `${home}/Applications/Cursor.app`]
      : platform === "win32"
        ? [`${local}\\Programs\\cursor`, `${programs}\\Cursor`]
        : [];
  for (const candidate of candidates) {
    if (exists(candidate)) return { installed: true, path: candidate };
  }
  return { installed: false };
}

/**
 * Probe Cursor two ways: the `cursor-agent` alias on PATH, and the editor on
 * disk. Both are reported when both answer, because they are different facts
 * and the caller says which it acted on.
 *
 * The alias is the only executable name trusted here. A generic `agent`
 * executable can belong to unrelated software even when its version output
 * carries a semver, and treating that as Cursor writes another program's path
 * into the enrollment record (#3384, finding 18).
 *
 * The editor matters because `~/.cursor/hooks.json` governs it and the CLI
 * alike, so a machine with the editor alone is a supported install that the
 * alias probe alone reports as absent (#3349).
 */
export function cursorFacts(
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home?: string,
  exists?: (candidate: string) => boolean,
): CursorFacts {
  const app =
    exists === undefined
      ? cursorAppFacts(platform, home, env)
      : cursorAppFacts(platform, home ?? homedir(), env, exists);
  const found = app.installed ? { app } : {};
  for (const name of CURSOR_CLI_NAMES) {
    const facts =
      exists === undefined
        ? harnessFacts(exec, name, platform, env, home)
        : harnessFacts(exec, name, platform, env, home, exists);
    if (facts.version !== undefined) return { ...facts, ...found };
  }
  return found;
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
  const exec = overrides.exec ?? realExec;
  const platform = overrides.platform ?? process.platform;
  // `platform` is resolved BEFORE the paths and handed to `tachoPaths`, which
  // derives one field from it — `claudeDesktopConfig`, undefined where Claude
  // Desktop has no build. Omitting it let that one field read `process.platform`
  // while `claudeDesktop()`, `runtimeCommands()` and the service manager beside
  // it all used the override, so a deps object built with an explicit platform
  // reported the app installed and had nowhere to write its config. Benign on a
  // real host, where the two agree; the same disagreement in `scratchPaths` is
  // what made the detect tests pass on macOS and fail on Linux CI.
  const paths = overrides.paths ?? tachoPaths(env, home, platform);
  const harnessFiles = new HarnessFiles(paths.root);
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
    execLong: overrides.execLong ?? overrides.exec ?? realExecLong,
    codexAppServer: (requests) =>
      // Resolved per call: `codex` may be installed between one command and
      // the next, and the probe is cheap next to spawning the server.
      codexAppServerClient({
        binary:
          harnessFacts(exec, "codex", platform, env, home).path ?? "codex",
        cwd: process.cwd(),
        env: env as NodeJS.ProcessEnv,
        clientName: "tacho",
        clientVersion: TACHO_VERSION,
      })(requests),
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
    // Every one of these harness files carries TACHO_LOCAL_TOKEN — the bearer the
    // loopback listener requires, and the one thing on this machine that lets a
    // process reach the daemon and, through the gateway, the host's own Oxagen
    // API key. So `HarnessFiles.write` holds each at 0600 while the machine is
    // enrolled: on a shared machine, 0644 let any other OS account read the
    // token out of a file it does not own. The user's own mode, bytes and
    // symlink come back at unenroll (`settleHarnessFiles`).
    readSettings: () => harnessFiles.readJson(paths.claudeSettings),
    writeSettings: (document) =>
      harnessFiles.write(
        paths.claudeSettings,
        `${JSON.stringify(document, null, 2)}\n`,
      ),
    readCodexHooks: () => harnessFiles.readJson(paths.codexHooks),
    writeCodexHooks: (document) =>
      harnessFiles.write(
        paths.codexHooks,
        `${JSON.stringify(document, null, 2)}\n`,
      ),
    readCursorHooks: (path) => harnessFiles.readJson(path),
    writeCursorHooks: (path, document, vestigial = false) =>
      harnessFiles.write(
        path,
        `${JSON.stringify(document, null, 2)}\n`,
        vestigial,
      ),
    readStellaHooks: (format) => readStellaHooksFile(paths, format),
    writeStellaHooks: (file) => harnessFiles.write(file.path, file.text ?? ""),
    readClaudeDesktopConfig: () =>
      paths.claudeDesktopConfig === undefined
        ? undefined
        : harnessFiles.readJson(paths.claudeDesktopConfig),
    writeClaudeDesktopConfig: (document) => {
      if (paths.claudeDesktopConfig === undefined)
        throw new Error(
          "Claude Desktop has no config path on this platform; Anthropic ships no build for it",
        );
      harnessFiles.write(
        paths.claudeDesktopConfig,
        `${JSON.stringify(document, null, 2)}\n`,
      );
    },
    harnessWriteProblem: (path) => harnessFiles.writeProblem(path),
    settleHarnessFiles: () => harnessFiles.settle(),
    modelBaseUrls: {
      apply: (options) => applyModelBaseUrls(options),
      restore: (options) => restoreModelBaseUrls(options),
      read: (options) => readModelBaseUrlState(options),
    },
    modelCredentials: {
      peek: (options) => peekModelCredentials(options),
      apply: (options) => applyModelCredentials(options),
      restore: (options, secrets) => restoreModelCredentials(options, secrets),
      read: (options) => readModelCredentialState(options),
    },
    credentialStore: openCredentialStore({
      file: paths.credentials,
      key: paths.credentialsKey,
    }),
    daemonPost: async (path, body) => {
      const host = readHostFile(paths.hostFile);
      if (host === undefined) return undefined;
      try {
        return await postUnix({
          ...(platform === "win32"
            ? { loopbackPort: host.port }
            : { socketPath: paths.socket }),
          path,
          headers: { Authorization: `Bearer ${host.local_token}` },
          body: JSON.stringify(body),
          connectTimeoutMs: 250,
          responseTimeoutMs: 2_000,
        });
      } catch {
        return undefined;
      }
    },
    claude: () => claudeFacts(exec, platform, env, home),
    codex: () => harnessFacts(exec, "codex", platform, env, home),
    cursor: () => cursorFacts(exec, platform, env, home),
    stella: () => harnessFacts(exec, "stella", platform, env, home),
    claudeDesktop: () => claudeDesktopFacts(platform, home, env),
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
    wrapperVersion: TACHO_VERSION,
    ...overrides,
  };
}
