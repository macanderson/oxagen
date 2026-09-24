/**
 * `oxagen init` — bind the current project to an Oxagen org + workspace.
 *
 * Init is the one command that establishes *tenant scope* for every other CLI
 * command: it resolves (or reuses) the org → workspace pair and writes
 * `.oxagen/workspace.json`, which `lib/resolve.ts` reads to scope `secret`,
 * `env`, `memory`, `graph`, `trace` and friends. It then checks whether the
 * workspace has a GitHub connection and — interactively — offers to create one,
 * so the knowledge graph has a source to ground on.
 *
 * Everything here talks to the platform API. The settings-file scaffolding init
 * used to do (`.oxagen/settings.json`, permissions, hooks, model defaults)
 * configured the local coding agent, which was retired with the runtime
 * (ADR-043) — Stella owns that file format now.
 *
 * `init` is idempotent: re-running against an already-linked project reuses the
 * existing link instead of re-prompting. `--org` and `--workspace` name the
 * pair outright, which is what makes init work without a terminal to prompt
 * in, and when they name a different pair than the existing link, init
 * relinks to them.
 *
 * The link is written at the project root: the git top level inside a
 * repository, else the directory init ran in. `oxagen steering` and `oxagen
 * pull` look for it there. Inside a repository init also makes sure git
 * ignores the link, because it binds one machine, not every clone.
 *
 * Last, init reports the directory to Oxagen (`record_working_copy`), so the
 * Working copies tab on the Repositories page lists it. The report is
 * best-effort: a failure prints one warning and init still succeeds.
 */
import { spawn } from "node:child_process";
import { getToken } from "../lib/config.js";
import { resolveLinkedAccount } from "../lib/linker.js";
import {
  ensureWorkspaceLinkIgnored,
  projectRootFor,
  reportWorkingCopy,
  type WorkingCopyOutcome,
} from "../lib/working-copy.js";
import {
  readWorkspaceLink,
  writeWorkspaceLink,
  workspaceLinkPath,
  type WorkspaceLink,
} from "./workspace-link.js";
import { apiPostOrThrow, apiGetOrThrow } from "../lib/api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitOptions {
  /**
   * Where init runs. Defaults to process.cwd(). The link is written at the
   * git top level containing it, or here when it is not in a repository.
   */
  cwd?: string;
  /** `--org`: the organization slug to link, instead of the picker. */
  org?: string;
  /** `--workspace`: the workspace slug to link, instead of the picker. */
  workspace?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  /** Skip the workspace linker step entirely. */
  noLink?: boolean;
  /**
   * Fired at each phase boundary of the real work below — awaited between
   * phases, so a caller can gate on a phase actually finishing.
   */
  onProgress?: (event: InitProgressEvent) => void | Promise<void>;
}

/** Real phase-boundary events emitted by runInit. */
export type InitProgressEvent = { phase: "link"; status: "start" | "done" };

export interface InitWorkspaceLinkResult {
  linked: boolean;
  orgSlug?: string;
  orgName?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  repos?: Array<{ provider: "github"; fullName: string }>;
  /** Set when `--org` / `--workspace` replaced a link to another pair. */
  relinkedFrom?: { orgSlug: string; workspaceSlug: string };
  /** Reason linking was skipped (no token, --no-link, or error). */
  skippedReason?: string;
}

export interface InitResult {
  /** The directory the link belongs to: the git top level, or the cwd. */
  projectRoot: string;
  /** Absolute path to the workspace-link file this project uses. */
  workspaceLinkPath: string;
  workspaceLink: InitWorkspaceLinkResult | null;
  /** The `.gitignore` init appended the link to, or null when it did not. */
  gitignoreUpdated: string | null;
  /** The working-copy report: the recorded id, or why it failed. Null when not linked. */
  workingCopy: WorkingCopyOutcome | null;
}

/** The org and workspace a request addresses, as slugs. */
type Scope = { org: string; ws: string };

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
}

interface ConnectionGetResult {
  publicId: string;
  status: string;
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
}

interface GitHubRepository {
  fullName: string;
}

/**
 * Check whether the workspace already has a connected GitHub source connection.
 * Returns the connection if found, null otherwise.
 */
async function findGitHubConnection(
  scope: Scope,
): Promise<ConnectionListItem | null> {
  const { connections } = await apiGetOrThrow<{
    connections: ConnectionListItem[];
  }>("connections", { connectorId: "github" }, scope);
  const connected = connections.find(
    (c) => c.connectorId === "github" && c.status === "connected",
  );
  return connected ?? null;
}

/**
 * Poll connection status at `publicId` every `intervalMs` until it reports
 * `connected`, or until `timeoutMs` elapses.
 */
async function pollConnectionStatus(
  publicId: string,
  { intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number },
  scope: Scope,
): Promise<"connected" | "timeout" | "error"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    try {
      const conn = await apiGetOrThrow<ConnectionGetResult>(
        `connections/${publicId}`,
        undefined,
        scope,
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
 * Returns the repos recorded in the workspace link on success, or null when the
 * flow did not complete. Never throws.
 */
async function connectGitHub(scope: Scope): Promise<Array<{
  provider: "github";
  fullName: string;
}> | null> {
  process.stdout.write(`\nCreating GitHub connection...\n`);
  let connection: ConnectionCreateResult;
  try {
    connection = await apiPostOrThrow<ConnectionCreateResult>(
      "connections",
      {
        connectorId: "github",
        displayName: "GitHub",
        authCredential: {},
      },
      scope,
    );
  } catch (err) {
    process.stdout.write(
      `  Could not create GitHub connection: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  let authUrl: string;
  try {
    const result = await apiGetOrThrow<{ authUrl: string }>(
      `connections/github/auth-url`,
      { connectionId: connection.publicId },
      scope,
    );
    authUrl = result.authUrl;
  } catch (err) {
    process.stdout.write(
      `  Could not get GitHub auth URL: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  process.stdout.write(`\nOpening GitHub authorization in your browser...\n`);
  process.stdout.write(`  URL: ${authUrl}\n`);
  process.stdout.write(
    `  If it doesn't open automatically, paste the URL above into your browser.\n`,
  );
  openUrlInBrowser(authUrl);

  process.stdout.write(
    `\nWaiting for GitHub authorization (timeout: 3 min)...\n`,
  );
  const pollResult = await pollConnectionStatus(
    connection.publicId,
    { intervalMs: 5_000, timeoutMs: 3 * 60 * 1_000 },
    scope,
  );

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

  process.stdout.write(`\nGitHub connected! Fetching repositories...\n`);
  const repos: Array<{ provider: "github"; fullName: string }> = [];
  try {
    const { installations } = await apiGetOrThrow<{
      installations: GitHubInstallation[];
    }>(
      `connections/github/installations`,
      { connectionId: connection.publicId },
      scope,
    );

    for (const inst of installations) {
      try {
        const { repositories } = await apiGetOrThrow<{
          repositories: GitHubRepository[];
        }>(
          `connections/github/installations/${inst.id}/repositories`,
          { connectionId: connection.publicId },
          scope,
        );
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
 * Pick an org + workspace, write `.oxagen/workspace.json`, then check for (or
 * offer to create) a GitHub connection. Best-effort: any error is returned in
 * the result, never thrown.
 */
async function runWorkspaceLinker(
  root: string,
  flags: { org?: string; workspace?: string },
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

  // Re-use an existing link when already linked (skip the picker; idempotent),
  // unless --org / --workspace name a different pair.
  const existing = readWorkspaceLink(root);
  const namesOtherPair =
    existing !== null &&
    ((flags.org !== undefined && flags.org !== existing.orgSlug) ||
      (flags.workspace !== undefined &&
        flags.workspace !== existing.workspaceSlug));
  let relinkedFrom: InitWorkspaceLinkResult["relinkedFrom"];
  if (existing && !namesOtherPair) {
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
    // A --workspace alone keeps the linked org. A new --org alone leaves the
    // workspace to the picker, because the old slug belongs to the old org.
    const orgSlug = flags.org ?? existing?.orgSlug;
    const workspaceSlug =
      flags.workspace ??
      (existing && orgSlug === existing.orgSlug
        ? existing.workspaceSlug
        : undefined);
    try {
      account = await resolveLinkedAccount({ orgSlug, workspaceSlug, isTTY });
    } catch (err) {
      return {
        linked: false,
        skippedReason: `Workspace picker failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // A relink starts clean: the repos and the pull base belong to the pair
    // the old link named, not to this one.
    const link: WorkspaceLink = {
      orgSlug: account.orgSlug,
      orgId: account.orgId,
      orgName: account.orgName,
      workspaceSlug: account.workspaceSlug,
      workspaceId: account.workspaceId,
      workspaceName: account.workspaceName,
      linkedAt: new Date().toISOString(),
    };
    writeWorkspaceLink(root, link);
    if (existing) {
      relinkedFrom = {
        orgSlug: existing.orgSlug,
        workspaceSlug: existing.workspaceSlug,
      };
      process.stdout.write(
        `  Relinked: ${account.orgName} / ${account.workspaceName} ` +
          `(was ${existing.orgSlug} / ${existing.workspaceSlug})\n`,
      );
    } else {
      process.stdout.write(
        `  Linked: ${account.orgName} / ${account.workspaceName}\n`,
      );
    }
  }
  const scope: Scope = { org: account.orgSlug, ws: account.workspaceSlug };

  // ── GitHub connection ──────────────────────────────────────────────────────
  let repos: Array<{ provider: "github"; fullName: string }> | undefined;
  try {
    const githubConn = await findGitHubConnection(scope);
    if (githubConn) {
      process.stdout.write(
        `\nGitHub connection: ${githubConn.displayName} (${githubConn.status})\n`,
      );
    } else if (isTTY) {
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
        const connected = await connectGitHub(scope);
        if (connected) repos = connected;
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

  const currentLink = readWorkspaceLink(root);
  if (currentLink && repos) {
    writeWorkspaceLink(root, { ...currentLink, repos });
  }

  return {
    linked: true,
    orgSlug: account.orgSlug,
    orgName: account.orgName,
    workspaceSlug: account.workspaceSlug,
    workspaceName: account.workspaceName,
    repos: repos ?? currentLink?.repos,
    ...(relinkedFrom ? { relinkedFrom } : {}),
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

/** Format an InitResult into a human-readable summary string. */
export function formatInitSummary(result: InitResult): string {
  const lines: string[] = [];
  lines.push(`Workspace link: ${result.workspaceLinkPath}`);

  if (result.workspaceLink === null) {
    lines.push("  Skipped (--no-link).");
    return lines.join("\n");
  }

  if (result.workspaceLink.linked) {
    const wl = result.workspaceLink;
    lines.push(
      `  Linked: ${wl.orgName ?? wl.orgSlug} / ${wl.workspaceName ?? wl.workspaceSlug}`,
    );
    if (wl.relinkedFrom) {
      lines.push(
        `  Replaced the link to ${wl.relinkedFrom.orgSlug} / ${wl.relinkedFrom.workspaceSlug}.`,
      );
    }
    if (wl.repos && wl.repos.length > 0) {
      lines.push(
        `  Repos:  ${wl.repos
          .map((r) => r.fullName)
          .slice(0, 5)
          .join(", ")}` +
          (wl.repos.length > 5 ? ` … +${wl.repos.length - 5} more` : ""),
      );
    }
  } else if (result.workspaceLink.skippedReason) {
    lines.push(`  ${result.workspaceLink.skippedReason}`);
  }

  if (result.gitignoreUpdated) {
    lines.push(`  Added .oxagen/workspace.json to ${result.gitignoreUpdated}.`);
  }
  if (result.workingCopy && "workingCopyId" in result.workingCopy) {
    lines.push(
      `  Reported this directory to Oxagen (${result.workingCopy.workingCopyId}).`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/** Run the init workflow and return a structured result. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const root = await projectRootFor(opts.cwd ?? process.cwd());
  const emit = async (event: InitProgressEvent): Promise<void> => {
    await opts.onProgress?.(event);
  };

  let workspaceLink: InitWorkspaceLinkResult | null = null;
  let gitignoreUpdated: string | null = null;
  let workingCopy: WorkingCopyOutcome | null = null;
  if (!opts.noLink) {
    await emit({ phase: "link", status: "start" });
    workspaceLink = await runWorkspaceLinker(root, {
      org: opts.org,
      workspace: opts.workspace,
    });
    await emit({ phase: "link", status: "done" });
  }

  if (workspaceLink?.linked) {
    try {
      // Reported in the summary (and in --json as `gitignoreUpdated`).
      gitignoreUpdated = await ensureWorkspaceLinkIgnored(root);
    } catch (err) {
      process.stderr.write(
        `Warning: could not add .oxagen/workspace.json to .gitignore: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    const link = readWorkspaceLink(root);
    if (link) {
      workingCopy = await reportWorkingCopy({
        root,
        scope: { org: link.orgSlug, ws: link.workspaceSlug },
        event: "init",
        pulledCommit: link.pull?.commit ?? null,
      });
      if ("error" in workingCopy) {
        process.stderr.write(
          `Warning: could not report this directory to Oxagen: ${workingCopy.error}\n`,
        );
      }
    }
  }

  return {
    projectRoot: root,
    workspaceLinkPath: workspaceLinkPath(root),
    workspaceLink,
    gitignoreUpdated,
    workingCopy,
  };
}

// ---------------------------------------------------------------------------
// CLI handler (writes to stdout)
// ---------------------------------------------------------------------------

/** Send `process.stdout.write` to stderr until the returned function runs. */
function divertStdoutToStderr(): () => void {
  const original = process.stdout.write;
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) =>
    process.stderr.write(...args)) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}

export async function handleInit(opts: InitOptions): Promise<void> {
  if (opts.noLink && (opts.org !== undefined || opts.workspace !== undefined)) {
    process.stderr.write(
      "--org and --workspace choose what to link, so they cannot be combined with --no-link.\n",
    );
    process.exitCode = 2;
    return;
  }
  for (const [flag, value] of [
    ["--org", opts.org],
    ["--workspace", opts.workspace],
  ] as const) {
    if (value !== undefined && value.trim().length === 0) {
      process.stderr.write(`${flag} needs a slug.\n`);
      process.exitCode = 2;
      return;
    }
  }

  process.stderr.write("Initializing…\n");

  // With --json, stdout carries the result and nothing else (ADR-023 §4). The
  // linker, the picker in lib/linker.ts and the GitHub step narrate on
  // stdout, so their lines go to stderr for the length of the run.
  const restoreStdout = opts.json ? divertStdoutToStderr() : () => {};
  let result: InitResult;
  try {
    result = await runInit(opts);
  } finally {
    restoreStdout();
  }

  // Named flags are a request to link that pair. When it could not be
  // linked, a script has to be able to tell, so the command fails.
  const named = opts.org !== undefined || opts.workspace !== undefined;
  if (named && result.workspaceLink && !result.workspaceLink.linked) {
    process.exitCode = 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatInitSummary(result) + "\n");
}
