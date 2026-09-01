/**
 * `oxagen init` engine — the side-effect-free core of the init command.
 *
 * This is a LEAF module: it imports the settings writer, workspace linker,
 * and API client, but it imports NO TUI/Ink code and does not import the
 * `init` command handler.
 *
 * "Side-effect-free" refers to the module graph, not the runtime: `runInit`
 * still writes settings files and (optionally) runs the interactive
 * workspace linker — it just pulls in none of the rendering layer.
 *
 * The local code graph this step used to build was retired in the Stella
 * cutover (Stella owns code indexing); init is now settings + workspace link.
 *
 * Mirrors the Claude Code `~/.claude` (global) + `.claude/` (project) two-tier
 * model. Precedence (lowest → highest), matching the existing settings/resolve.ts:
 *   1. Global user:  ~/.oxagen/settings.json
 *   2. Project:      <cwd>/.oxagen/settings.json
 *   3. Local:        <cwd>/.oxagen/settings.local.json  (not written by init)
 *
 * Credentials (token, org, workspace, gatewayKey) intentionally stay in
 * ~/.config/oxagen/config.json — never in settings files — consistent with
 * Claude Code keeping .credentials.json separate from settings.json.
 *
 * `init` is idempotent: re-running leaves any existing settings files
 * untouched (no clobbering).
 *
 * Workspace linker (skippable with --no-link):
 *   After the settings scaffold, if a platform session exists (getToken() present)
 *   the linker runs the org → workspace picker and writes .oxagen/workspace.json.
 *   Then it checks for a GitHub connection in the workspace and offers to create
 *   one if none exists (best-effort: any error in this step is printed but does
 *   not fail init).
 */
import { spawn } from "node:child_process";
import { writeStarterSettings } from "../settings/write.js";
import { getToken } from "../lib/config.js";
import { resolveLinkedAccount } from "../lib/linker.js";
import {
  readWorkspaceLink,
  writeWorkspaceLink,
  type WorkspaceLink,
} from "./workspace-link.js";
import { apiPostOrThrow, apiGetOrThrow } from "../lib/api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Workspace root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override user settings path (test seam). */
  userSettingsPath?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  /** Skip the workspace linker step entirely. */
  noLink?: boolean;
  /**
   * Fired at each phase boundary of the REAL work below (settings, workspace
   * link) — awaited between phases, so a caller can gate on a phase actually
   * finishing.
   */
  onProgress?: (event: InitProgressEvent) => void | Promise<void>;
}

/** Real phase-boundary events emitted by runInit. */
export type InitProgressEvent =
  | { phase: "settings"; status: "start" | "done" }
  | { phase: "link"; status: "start" };

export interface InitWorkspaceLinkResult {
  linked: boolean;
  orgSlug?: string;
  orgName?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  repos?: Array<{ provider: "github"; fullName: string }>;
  /** Reason linking was skipped (no token, --no-link, or error). */
  skippedReason?: string;
}

export interface InitResult {
  projectSettingsPath: string;
  projectSettingsCreated: boolean;
  userSettingsPath: string;
  userSettingsCreated: boolean;
  workspaceLink: InitWorkspaceLinkResult | null;
}

// ---------------------------------------------------------------------------
// Settings scaffolding
// ---------------------------------------------------------------------------

/**
 * Ensure both the global user and project settings files exist.
 * Returns paths and whether each was newly created.
 * Never clobbers existing files — idempotent.
 */
export function ensureSettingsFiles(opts: {
  cwd: string;
  userSettingsPath?: string;
}): {
  projectPath: string;
  projectCreated: boolean;
  userPath: string;
  userCreated: boolean;
} {
  const user = writeStarterSettings({
    scope: "user",
    cwd: opts.cwd,
    userSettingsPath: opts.userSettingsPath,
  });
  const project = writeStarterSettings({
    scope: "project",
    cwd: opts.cwd,
    userSettingsPath: opts.userSettingsPath,
  });
  return {
    userPath: user.path,
    userCreated: user.created,
    projectPath: project.path,
    projectCreated: project.created,
  };
}

// ---------------------------------------------------------------------------
// GitHub connection helpers
// ---------------------------------------------------------------------------

/** Open a URL in the system's default browser (cross-platform, no npm dep). */
function openUrlInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal — the URL is always printed as a fallback.
  }
}

interface ConnectionListItem {
  id: string;
  publicId: string;
  connectorId: string;
  displayName: string;
  status: string;
  entityCount: number;
  lastSyncAt: string | null;
  createdAt: string;
}

interface ConnectionGetResult {
  id: string;
  publicId: string;
  connectorId: string;
  displayName: string;
  status: string;
  entityCount: number;
  lastSyncAt: string | null;
  errorMessage: string | null;
}

interface ConnectionCreateResult {
  connectionId: string;
  publicId: string;
  status: string;
  connectorId: string;
  displayName: string;
}

interface GitHubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  avatarUrl: string;
  htmlUrl: string | null;
}

interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
}

/**
 * Check whether the workspace already has a connected GitHub source connection.
 * Returns the connection if found, null otherwise.
 * Uses GET /v1/:org/:ws/connections?connectorId=github.
 */
async function findGitHubConnection(): Promise<ConnectionListItem | null> {
  const { connections } = await apiGetOrThrow<{
    connections: ConnectionListItem[];
  }>("connections", { connectorId: "github" });
  const connected = connections.find(
    (c) => c.connectorId === "github" && c.status === "connected",
  );
  return connected ?? null;
}

/**
 * Poll connection status at `publicId` every `intervalMs` until it reports
 * `connected`, or until `timeoutMs` elapses.
 * Returns "connected" | "timeout" | "error".
 */
async function pollConnectionStatus(
  publicId: string,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
): Promise<"connected" | "timeout" | "error"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    try {
      const conn = await apiGetOrThrow<ConnectionGetResult>(
        `connections/${publicId}`,
      );
      if (conn.status === "connected") return "connected";
      if (conn.status === "error") return "error";
      process.stdout.write(
        `  Waiting for GitHub authorization... (status: ${conn.status})\n`,
      );
    } catch {
      // Transient network error — keep polling.
    }
  }
  return "timeout";
}

/**
 * Run the GitHub connection flow: create a pending_setup connection, get the
 * OAuth auth URL, open it in the browser (with a printed fallback), then poll
 * until the connection is confirmed or we time out.
 *
 * Returns the list of repos recorded in the workspace link on success, or null
 * when the flow did not complete within the timeout.
 *
 * Any error is caught by the caller — this function itself never throws.
 */
async function connectGitHub(): Promise<Array<{
  provider: "github";
  fullName: string;
}> | null> {
  // 1. Create a pending_setup connection.
  process.stdout.write(`\nCreating GitHub connection...\n`);
  let connection: ConnectionCreateResult;
  try {
    connection = await apiPostOrThrow<ConnectionCreateResult>("connections", {
      connectorId: "github",
      displayName: "GitHub",
      authCredential: {},
    });
  } catch (err) {
    process.stdout.write(
      `  Could not create GitHub connection: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  // 2. Get the OAuth auth URL.
  let authUrl: string;
  try {
    const result = await apiGetOrThrow<{ authUrl: string }>(
      `connections/github/auth-url`,
      { connectionId: connection.publicId },
    );
    authUrl = result.authUrl;
  } catch (err) {
    process.stdout.write(
      `  Could not get GitHub auth URL: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  // 3. Open the URL in the browser.
  process.stdout.write(`\nOpening GitHub authorization in your browser...\n`);
  process.stdout.write(`  URL: ${authUrl}\n`);
  process.stdout.write(
    `  If it doesn't open automatically, paste the URL above into your browser.\n`,
  );
  openUrlInBrowser(authUrl);

  // 4. Poll for connected status (up to 3 minutes).
  process.stdout.write(
    `\nWaiting for GitHub authorization (timeout: 3 min)...\n`,
  );
  const pollResult = await pollConnectionStatus(connection.publicId, {
    intervalMs: 5_000,
    timeoutMs: 3 * 60 * 1_000,
  });

  if (pollResult === "timeout") {
    process.stdout.write(
      `\n  Timed out waiting for GitHub authorization.\n` +
        `  Re-run \`oxagen init\` after completing the GitHub flow in your browser.\n`,
    );
    return null;
  }
  if (pollResult === "error") {
    process.stdout.write(
      `\n  GitHub connection reported an error. Re-run \`oxagen init\` to try again.\n`,
    );
    return null;
  }

  // 5. List the repos the GitHub App has access to.
  process.stdout.write(`\nGitHub connected! Fetching repositories...\n`);
  const repos: Array<{ provider: "github"; fullName: string }> = [];
  try {
    const { installations } = await apiGetOrThrow<{
      installations: GitHubInstallation[];
    }>(`connections/github/installations`, {
      connectionId: connection.publicId,
    });

    for (const inst of installations) {
      try {
        const { repositories } = await apiGetOrThrow<{
          repositories: GitHubRepository[];
        }>(`connections/github/installations/${inst.id}/repositories`, {
          connectionId: connection.publicId,
        });
        for (const r of repositories) {
          repos.push({ provider: "github", fullName: r.fullName });
        }
      } catch {
        // Non-fatal: skip this installation's repos.
      }
    }
  } catch {
    // Non-fatal: proceed without repos.
  }

  if (repos.length > 0) {
    process.stdout.write(`  Repositories:\n`);
    for (const r of repos.slice(0, 10)) {
      process.stdout.write(`    ${r.fullName}\n`);
    }
    if (repos.length > 10) {
      process.stdout.write(`    … and ${repos.length - 10} more\n`);
    }
  } else {
    process.stdout.write(
      `  No repositories found. Install the Oxagen GitHub App on an org with repos.\n`,
    );
  }

  return repos;
}

// ---------------------------------------------------------------------------
// Workspace linker step
// ---------------------------------------------------------------------------

/**
 * Run the workspace linker step: pick an org + workspace and write
 * .oxagen/workspace.json. Then check for / offer to create a GitHub connection.
 * Best-effort: any error is returned in the result, never thrown.
 */
async function runWorkspaceLinker(
  cwd: string,
): Promise<InitWorkspaceLinkResult> {
  const token = getToken();
  if (!token) {
    return {
      linked: false,
      skippedReason:
        "No platform session. Run `oxagen login` then `oxagen init` to link a workspace.",
    };
  }

  const isTTY = process.stdin.isTTY ?? false;
  process.stdout.write(`\nLinking workspace...\n`);

  let account: {
    orgId: string;
    orgSlug: string;
    orgName: string;
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
  };

  // Re-use an existing link when already linked (skip the picker; idempotent).
  const existing = readWorkspaceLink(cwd);
  if (existing) {
    process.stdout.write(
      `  Already linked: ${existing.orgName} / ${existing.workspaceName}\n`,
    );
    account = {
      orgId: existing.orgId,
      orgSlug: existing.orgSlug,
      orgName: existing.orgName,
      workspaceId: existing.workspaceId,
      workspaceSlug: existing.workspaceSlug,
      workspaceName: existing.workspaceName,
    };
  } else {
    try {
      account = await resolveLinkedAccount({ isTTY });
    } catch (err) {
      return {
        linked: false,
        skippedReason: `Workspace picker failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Write the initial link (no repos yet).
    const link: WorkspaceLink = {
      orgSlug: account.orgSlug,
      orgId: account.orgId,
      orgName: account.orgName,
      workspaceSlug: account.workspaceSlug,
      workspaceId: account.workspaceId,
      workspaceName: account.workspaceName,
      linkedAt: new Date().toISOString(),
    };
    writeWorkspaceLink(cwd, link);
    process.stdout.write(
      `  Linked: ${account.orgName} / ${account.workspaceName}\n`,
    );
  }

  // ── GitHub connection ────────────────────────────────────────────────────────
  let repos: Array<{ provider: "github"; fullName: string }> | undefined;
  try {
    const githubConn = await findGitHubConnection();
    if (githubConn) {
      process.stdout.write(
        `\nGitHub connection: ${githubConn.displayName} (${githubConn.status})\n`,
      );
      // If the workspace was freshly linked, surface any repos from the connection.
      // We don't know them from the connection list alone, so leave repos empty —
      // users can re-run init to pick them up after a full sync.
    } else if (isTTY) {
      // Offer the GitHub connect flow.
      process.stdout.write(`\nNo GitHub connection found in this workspace.\n`);
      process.stdout.write(
        `  Connect GitHub to let Oxagen index your repositories.\n`,
      );
      const { default: readline } = await import("node:readline/promises");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      let answer: string;
      try {
        answer = (await rl.question("  Connect GitHub now? [y/N]: "))
          .trim()
          .toLowerCase();
      } finally {
        rl.close();
      }
      if (answer === "y" || answer === "yes") {
        const connected = await connectGitHub();
        if (connected) {
          repos = connected;
        }
      } else {
        process.stdout.write(
          `  Skipped. Run \`oxagen init\` again to connect GitHub later.\n`,
        );
      }
    } else {
      process.stdout.write(
        `  No GitHub connection found. Run \`oxagen init\` interactively to connect.\n`,
      );
    }
  } catch (err) {
    // GitHub step is best-effort — print and continue.
    process.stdout.write(
      `  GitHub connection check failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Update the workspace link with repos if we got them.
  const currentLink = readWorkspaceLink(cwd);
  if (currentLink && repos) {
    writeWorkspaceLink(cwd, { ...currentLink, repos });
  }

  return {
    linked: true,
    orgSlug: account.orgSlug,
    orgName: account.orgName,
    workspaceSlug: account.workspaceSlug,
    workspaceName: account.workspaceName,
    repos: repos ?? currentLink?.repos,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

/** Format an InitResult into a human-readable summary string. */
export function formatInitSummary(result: InitResult): string {
  const lines: string[] = [];

  // Settings tier
  lines.push("Settings:");
  lines.push(
    `  ${result.userSettingsCreated ? "Created" : "Found  "}  ${result.userSettingsPath}  (global)`,
  );
  lines.push(
    `  ${result.projectSettingsCreated ? "Created" : "Found  "}  ${result.projectSettingsPath}  (project)`,
  );
  lines.push(
    "  Precedence: global < project < local (.oxagen/settings.local.json)",
  );

  // Workspace link
  if (result.workspaceLink !== null) {
    lines.push("");
    if (result.workspaceLink?.linked) {
      const wl = result.workspaceLink;
      lines.push(
        `Workspace: ${wl.orgName ?? wl.orgSlug} / ${wl.workspaceName ?? wl.workspaceSlug}`,
      );
      if (wl.repos && wl.repos.length > 0) {
        lines.push(
          `  Repos:   ${wl.repos
            .map((r) => r.fullName)
            .slice(0, 5)
            .join(", ")}` +
            (wl.repos.length > 5 ? ` … +${wl.repos.length - 5} more` : ""),
        );
      }
    } else if (result.workspaceLink?.skippedReason) {
      lines.push(`Workspace: ${result.workspaceLink.skippedReason}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run the init workflow and return a structured result.
 * Both the CLI handler and the REPL /init command call this.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  // Phase-boundary events are awaited (a caller may need a phase to be truly
  // finished before this continues).
  const emit = async (event: InitProgressEvent): Promise<void> => {
    await opts.onProgress?.(event);
  };

  // 1. Scaffold settings files (idempotent — never clobbers)
  await emit({ phase: "settings", status: "start" });
  const settings = ensureSettingsFiles({
    cwd,
    userSettingsPath: opts.userSettingsPath,
  });
  await emit({ phase: "settings", status: "done" });

  // 2. Workspace linker — skipped with --no-link or if no platform session
  let workspaceLink: InitWorkspaceLinkResult | null = null;
  if (!opts.noLink) {
    await emit({ phase: "link", status: "start" });
    workspaceLink = await runWorkspaceLinker(cwd);
  }

  return {
    projectSettingsPath: settings.projectPath,
    projectSettingsCreated: settings.projectCreated,
    userSettingsPath: settings.userPath,
    userSettingsCreated: settings.userCreated,
    workspaceLink,
  };
}
