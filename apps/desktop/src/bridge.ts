/**
 * The app's only two ways to touch the machine: the Rust commands in
 * src-tauri/src/lib.rs (reads, the two user-scoped API calls, PATH install)
 * and the bundled `tacho` / `oxagen` sidecars for every action that changes
 * state. Nothing here keeps state of its own.
 */
import type { InstallResult, RemovalReport } from "./machine-state";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import type { CliInstallReport, Harness } from "./commands";
import { parseTachoStatus, type TachoStatus } from "./tacho-status";

export interface CliConfigView {
  path: string;
  logged_in: boolean;
  org_slug: string | null;
  workspace_slug: string | null;
  api_url: string;
  app_url: string;
}

export interface HostView {
  host_enrollment_id: string;
  agent_key: string;
  organization_id: string;
  workspace_id: string;
  org_slug: string;
  workspace_slug: string;
  api_url: string;
  host_status: "active" | "paused" | "suspended" | "revoked";
  port: number;
  hostname: string;
  os_user: string;
  platform: string;
  harnesses: string[];
  managed: boolean;
  claude_version: string | null;
  claude_execpath: string | null;
  codex_version?: string | null;
  codex_execpath?: string | null;
  cursor_version?: string | null;
  cursor_execpath?: string | null;
  stella_version?: string | null;
  stella_execpath?: string | null;
  wrapper_version: string;
  hook_command: string;
  daemon_command: string[];
  enrolled_at: string;
  expires_at: string;
  revoked_at: string | null;
  bundle_fetched_at: string;
  device_key_fingerprint: string;
  bundle: { version: number; mode: "observe" | "enforce"; expires_at: string };
}

/**
 * One entry in the collector's `/status` `agents[]`: everything reporting
 * to this daemon, one row per harness or per `tacho hook --agent <name>`
 * custom agent. Consumed by `computeAgentRows` in `agents.ts`.
 */
export interface DaemonAgentSummary {
  key: string;
  runtime: "claude-code" | "codex" | "cursor" | "stella" | "custom" | string;
  harness: string;
  label: string;
  first_seen_at: string;
  last_seen_at: string;
  sessions_total: number;
  sessions_live: number;
}

export interface DaemonStatus {
  uptime_s?: number;
  spool_depth?: number;
  last_ingest_at?: string | null;
  last_error?: string | null;
  /**
   * Events the control plane refused as malformed. They are off the spool
   * and leave no error behind, so this count is the only sign they never
   * reached Oxagen. Absent on a collector that predates the field.
   */
  quarantined?: number;
  sessions?: unknown[];
  unobserved_sessions?: string[];
  agents?: DaemonAgentSummary[];
  /**
   * One row per MCP client that has called through the local gateway
   * (ADR-078). A separate list from `agents` on purpose: those are the
   * wrapped ones, and a surface that merged the two would have to invent a
   * tier for each row after the fact.
   */
  connected?: DaemonConnectedApp[];
  [key: string]: unknown;
}

/** A connected app the gateway has served, as `/status` reports it. */
export interface DaemonConnectedApp {
  /** The name the app gave in the MCP `initialize` handshake. */
  client: string;
  enforcement_tier: "gateway";
  calls: number;
  /** Calls the control plane refused. A refusal is a decision, so it counts. */
  refused: number;
  last_seen_at: string;
}

export interface DesktopState {
  platform: "macos" | "linux" | "windows" | string;
  arch: string;
  app_version: string;
  config: CliConfigView;
  host: HostView | null;
  /**
   * Why `host_path` exists but could not be read (unreadable, not UTF-8, not
   * a JSON object). Set, the machine may well be enrolled, so the app must not
   * offer the setup that would write over it. Optional: an older Rust shell
   * reports nothing and an unreadable file reads as no enrollment.
   */
  host_error?: string | null;
  host_path: string;
  daemon: DaemonStatus | null;
  log_path: string;
  /**
   * Whether `log_path` exists. The collector writes it on its first run, so
   * it is absent on a machine that has not been set up. Optional: a build of
   * the Rust shell that predates the field reports nothing.
   */
  log_present?: boolean;
  sidecar_dir: string | null;
  /**
   * The sidecar directory is gone after this launch (an AppImage mount, a
   * mounted .dmg, App Translocation): nothing durable may reference it.
   */
  sidecar_transient: boolean;
  /**
   * The directory hooks and the service may reference: the sidecar
   * directory, or the durable copy "Link into PATH" made; null while the app
   * runs from a transient directory with no copy yet (tacho refuses to
   * enroll until there is one).
   */
  bin_dir: string | null;
  oxagen_on_path: string | null;
  tacho_on_path: string | null;
  cli_install_dir: string;
  /**
   * Whether our own links to `oxagen` or `tacho` sit in `cli_install_dir`
   * right now. Separate from the two `*_on_path` fields, which resolve
   * against the running process's PATH: a GUI launch on macOS or Linux never
   * sources a login profile, so they read null even with the links in place.
   * Absent on a build that predates the field.
   */
  cli_links_present?: boolean;
  /**
   * What the launch-time auto-link of `oxagen` and `tacho` did, if the Rust
   * shell ran it this session. Absent on a build that predates it.
   */
  cli_install?: CliInstallReport;
}

export const readState = () => invoke<DesktopState>("desktop_state");

export const apiPost = <T>(path: string, body: unknown) =>
  invoke<T>("api_post", { path, body });

export type { InstallResult, RemovalReport } from "./machine-state";
export const installCli = () => invoke<InstallResult>("install_cli");
export const uninstallCli = () => invoke<string[]>("uninstall_cli");
/**
 * Everything the app itself put on the machine: the PATH links and the
 * profile block, the durable copy of the tools, and `~/.config/oxagen`.
 * Refused while the machine is still enrolled. The report names what was
 * removed and what is still there.
 */
export const removeLocalData = () => invoke<RemovalReport>("remove_local_data");
export const logTail = (lines = 120) => invoke<string>("log_tail", { lines });

/**
 * What a sidecar needs in its environment on top of the app's own:
 * `TACHO_BIN_DIR` at the durable copy of the tools while the app runs from a
 * directory that is gone after this launch (a mounted .dmg, an AppImage, App
 * Translocation), so the hooks and service an enroll writes point at a binary
 * that lasts. Asked before each run, so a copy made during this launch is used
 * at once. A Rust shell that predates the command answers nothing, and the
 * sidecar then inherits the app's environment as before.
 */
export async function sidecarEnv(): Promise<Record<string, string>> {
  try {
    return (await invoke<Record<string, string>>("sidecar_env")) ?? {};
  } catch {
    return {};
  }
}

export interface OrgItem {
  id: string;
  slug: string;
  name: string;
}
export interface WorkspaceItem {
  slug: string;
  name: string;
  id?: string;
}

export const listOrganizations = async (): Promise<OrgItem[]> =>
  (await apiPost<{ organizations: OrgItem[] }>("/v1/user/organizations", {}))
    .organizations;

/** `api_post` rejects with "401: ..." when the session token is dead. */
export function isUnauthorized(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /^401\b/.test(text);
}

export type SessionCheck =
  | { live: true }
  | { live: false; expired: boolean; message: string };

/**
 * Whether the saved session still works, asked of the control plane right
 * before an action that needs it. `tacho reassign` revokes the enrollment
 * first and enrolls again with the session; with a dead token it revoked,
 * stripped the hooks, failed to enroll and removed the service, so a harness
 * or workspace change unenrolled the machine. `logged_in` in config.json
 * only says a token is on disk, and the picker's 401 is learned once, at
 * launch. A control plane that cannot be reached is refused as well: the
 * same enroll would fail the same way.
 */
export async function checkLiveSession(
  list: () => Promise<unknown> = listOrganizations,
): Promise<SessionCheck> {
  try {
    await list();
    return { live: true };
  } catch (e) {
    if (isUnauthorized(e))
      return {
        live: false,
        expired: true,
        message: "Sign in again first. Nothing was changed.",
      };
    return {
      live: false,
      expired: false,
      message: `Could not reach Oxagen to check your sign-in: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`,
    };
  }
}

export const listWorkspaces = async (
  orgSlug: string,
): Promise<WorkspaceItem[]> =>
  (
    await apiPost<{ workspaces: WorkspaceItem[] }>("/v1/user/workspaces", {
      orgSlug,
    })
  ).workspaces;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Sidecar = "tacho" | "oxagen";

/**
 * Run a sidecar to completion, streaming lines to `onLine` as they arrive so
 * a six-step `enroll` reads as progress rather than a spinner.
 */
export async function runSidecar(
  name: Sidecar,
  args: string[],
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  // Extra variables only: an empty or absent `env` inherits the app's
  // environment, and Tauri clears it only for an explicit null.
  const env =
    options.env !== undefined && Object.keys(options.env).length > 0
      ? { env: options.env }
      : undefined;
  const command = Command.sidecar(`binaries/${name}`, args, env);
  let stdout = "";
  let stderr = "";
  command.stdout.on("data", (line: string) => {
    stdout += `${line}\n`;
    onLine?.(line, "stdout");
  });
  command.stderr.on("data", (line: string) => {
    stderr += `${line}\n`;
    onLine?.(line, "stderr");
  });
  return new Promise((resolve, reject) => {
    // A read-only probe (detect, status) gets a deadline: if the child never
    // reports close, the UI must fail with a message rather than wait.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        if (timer !== undefined) clearTimeout(timer);
        fn(v);
      };
    const done = settle(resolve);
    const fail = settle(reject);
    command.on("close", (payload: { code: number | null }) =>
      done({ code: payload.code, stdout, stderr }),
    );
    command.on("error", (error: unknown) =>
      fail(error instanceof Error ? error : new Error(String(error))),
    );
    command
      .spawn()
      .then((child) => {
        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            void Promise.resolve(child?.kill?.()).catch(() => undefined);
            fail(
              new Error(
                `${name} ${args.join(" ")} did not finish within ${Math.round(options.timeoutMs! / 1000)}s`,
              ),
            );
          }, options.timeoutMs);
        }
      })
      .catch(fail);
  });
}

export type { TachoStatus } from "./tacho-status";

/**
 * `tacho status --json`, the same document the CLI prints. `status` exits 1
 * when the machine is not enrolled but still prints the document, so the
 * exit code alone means nothing; a run that printed no document and either
 * failed or wrote to stderr (a host.json this build cannot parse, a service
 * probe that threw) is an error the caller must show, not a silent null.
 * Null is reserved for a clean run that printed nothing.
 */
export async function tachoStatus(): Promise<TachoStatus | null> {
  const result = await runSidecar("tacho", ["status", "--json"], undefined, {
    timeoutMs: 20_000,
  });
  const status = parseTachoStatus(result.stdout);
  if (status !== null) return status;
  const detail = result.stderr.trim();
  if (detail !== "" || result.code !== 0)
    throw new Error(
      detail || `tacho status exited ${result.code ?? "?"} without a document`,
    );
  return null;
}

/** `tacho detect --json`: which harnesses the machine has and which are hooked. */
export interface DetectedHarness {
  harness: Harness;
  label: string;
  installed: boolean;
  path?: string;
  version?: string;
  enrolled: boolean;
}
export interface DetectReport {
  enrolled: boolean;
  harnesses: DetectedHarness[];
}

/**
 * Four harnesses, each up to two login-shell lookups and a `--version` call,
 * every one bounded to 10 s in tacho: 120 s when every shell profile is at
 * its slowest. 45 s cut a slow but working scan short.
 */
export const DETECT_TIMEOUT_MS = 150_000;

/**
 * The detect document. A run that printed none is a failed scan and rejects:
 * read as an empty list, it told the operator none of their agents was
 * installed beside the error that said the scan had not worked.
 */
export async function detectHarnesses(): Promise<DetectReport> {
  const result = await runSidecar("tacho", ["detect", "--json"], undefined, {
    timeoutMs: DETECT_TIMEOUT_MS,
  });
  const report = parseDetect(result.stdout);
  if (report !== null) return report;
  throw new Error(
    result.stderr.trim() ||
      `tacho detect exited ${result.code ?? "?"} without a report`,
  );
}

/** The detect document, or null when the sidecar printed none. */
export function parseDetect(stdout: string): DetectReport | null {
  try {
    const parsed = JSON.parse(stdout) as DetectReport;
    return Array.isArray(parsed?.harnesses) ? parsed : null;
  } catch {
    return null;
  }
}

/** `tacho verify --harness <h> --json`: one recorded turn on that harness. */
export interface ConnectResult {
  ok: boolean;
  sessionId?: string;
  sessionUuid?: string;
  seq?: number;
  detail: string;
}

/** The last JSON line of a `verify --json` run, or a failure built from stderr. */
export function parseConnect(result: RunResult): ConnectResult {
  const last = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("{"));
  if (last) {
    try {
      const parsed = JSON.parse(last) as Partial<ConnectResult>;
      if (typeof parsed.ok === "boolean" && typeof parsed.detail === "string")
        return parsed as ConnectResult;
    } catch {
      // fall through to the stderr-based failure
    }
  }
  return {
    ok: false,
    detail:
      result.stderr.trim() ||
      `tacho verify exited ${result.code ?? "?"} without a result`,
  };
}

/**
 * One headless agent turn plus the wait for its chain to seal. Generous, and
 * bounded: with no bound at all a harness that hung left the Connect button
 * spinning for as long as the app stayed open, with nothing to click and no
 * reason given. `tacho verify` gives up well inside this on its own, so
 * reaching it means the harness never returned.
 */
const CONNECT_TIMEOUT_MS = 240_000;

export async function connectRun(
  harness: Harness,
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<ConnectResult> {
  const result = await runSidecar(
    "tacho",
    ["verify", "--harness", harness, "--json"],
    onLine,
    { timeoutMs: CONNECT_TIMEOUT_MS },
  );
  return parseConnect(result);
}
