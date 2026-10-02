/**
 * Where a Tacho host keeps its state (spec section 5.1). Everything lives
 * under one directory so a test can point `TACHO_HOME` at a scratch
 * directory. Each agent on the machine has a directory of its own under
 * `agents/`, with the same files in it (ADR-203). No enrollment lives in the
 * tacho directory itself: it holds only what the one `tachod` service needs.
 *
 * The same `~/.config/oxagen` root is used on every platform, Windows
 * included, so `oxagen login` (apps/cli) and the desktop app read one file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeDesktopConfigPath } from "./claude-desktop-writer";
import { cursorHooksPaths } from "./cursor-writer";

/**
 * The machine-level paths: the tacho directory, the one `tachod` service that
 * serves every agent, and the harness config files, which belong to the user
 * and not to any one agent.
 */
export interface TachoHome {
  /** `~/.config/oxagen/tacho` unless `TACHO_HOME` overrides it. */
  tachoDir: string;
  /** `<tachoDir>/agents`: one directory per agent on this machine (ADR-203). */
  agents: string;
  /** The daemon's pid file. */
  pid: string;
  /** Daemon stdout/stderr when run as a service. */
  log: string;
  /**
   * The wrapper script the Windows scheduled task runs (sets the env, then
   * starts `tachod`). Unused on macOS and Linux, where the unit carries env.
   */
  daemonLauncher: string;
  /** Claude Code's user settings file. */
  claudeSettings: string;
  /** Claude Code's transcript root. */
  claudeProjects: string;
  /** Codex CLI's user hooks file (`~/.codex/hooks.json`). */
  codexHooks: string;
  /**
   * Cursor's user hooks files, most likely first. Normally one
   * (`~/.cursor/hooks.json`); two when `CURSOR_CONFIG_DIR` or, on Linux and
   * BSD, `XDG_CONFIG_HOME` moves the config directory, because Cursor
   * documents those variables for the CLI config directory and not for the
   * hooks loader. See `cursor-writer.ts`.
   */
  cursorHooks: string[];
  /**
   * Stella's user config (`$STELLA_HOME/stella.toml`, `~/.stella` by
   * default). When it exists it wins whole over `stellaSettingsJson`.
   */
  stellaToml: string;
  /** Stella's legacy user settings (`$STELLA_HOME/settings.json`). */
  stellaSettingsJson: string;
  /**
   * Claude Desktop's MCP client config, or undefined on a platform Anthropic
   * ships no build for — Linux, as of 2026-09-16. See
   * `claude-desktop-writer.ts` for the paths and the date they were verified.
   */
  claudeDesktopConfig: string | undefined;
}

/**
 * One agent's paths: the machine's, plus the directory that holds the
 * agent's enrollment and every file that belongs to it. Every agent has the
 * same layout, at `<tachoDir>/agents/<id>/` (ADR-203).
 */
export interface TachoPaths extends TachoHome {
  /** The agent's directory. */
  dir: string;
  /** Enrollment identity, credentials, cached bundle (0600). */
  hostFile: string;
  /** Ed25519 device private key, PKCS#8 PEM (0600). */
  deviceKey: string;
  /** The HMAC key that signs this agent's run tokens (0600; `host/run-token.ts`). */
  runTokenKey: string;
  /** Vendor credentials in the gateway's custody, sealed (`host/credential-store.ts`). */
  credentials: string;
  /** The key that seals `credentials`, in its own file so a copy of one is useless. */
  credentialsKey: string;
  /** The collector's Unix socket (unused on Windows, where the hook uses TCP). */
  socket: string;
  /** Per-session append-only event logs and the shipped cursor. */
  wal: string;
  /** Events `tacho-hook` recorded while the daemon was down. */
  spool: string;
  /** Batches the control plane refused, kept for inspection. */
  quarantine: string;
  /** Recorder state the daemon persists so a restart continues each chain. */
  daemonState: string;
  /**
   * The sealed sessions `daemonState` leaves out once they are released, and
   * the commands the daemon answered. Written only when either changes.
   */
  daemonSealedState: string;
  /**
   * Sealed terminal batches the daemon has not yet landed in the WAL. A batch
   * waits here for the moment between sealing and the WAL append, so the file
   * can hold a run's content and has to be purged with the WAL (ADR-139).
   */
  pendingEnds: string;
  /**
   * Hook ids the daemon recorded since it last wrote `daemonState`, one JSON
   * line each, so a crash between two state writes does not forget which
   * hooks a spool replay would repeat. Ids and seqs only, no content.
   */
  hookIdJournal: string;
  /** Transcript byte cursors, so a restart does not re-read every transcript. */
  transcriptTailState: string;
  /**
   * Each Stella context store the memory scan found, with the last memory use
   * it took there, so a restart counts no use twice
   * (`collector/memory-capture/stella-memories.ts`). Paths and numbers only,
   * no memory text.
   */
  stellaMemoryCursors: string;
  /**
   * Copies of the files that held uncommitted edits when a session first
   * read a worktree, one directory per session, so a reconciliation can
   * count only the session's lines in them (ADR-188). Never shipped, and
   * removed when the daemon forgets the session.
   */
  preSessionCopies: string;
  /**
   * The Stella identity cache: one file per Stella process, holding its pid
   * and start time, so most Stella hooks run no `ps` (`resolveStellaIdentity`).
   * A cache only, so `oxagen agent unenroll` removes it.
   */
  stellaIdentity: string;
}

/**
 * The name of each file an agent keeps in its directory. A new `TachoPaths`
 * field that is not a `TachoHome` one is a type error here until it has a
 * name, so no agent's file can land outside the agent's directory.
 */
export const AGENT_FILES: Record<
  Exclude<keyof TachoPaths, keyof TachoHome | "dir">,
  string
> = {
  hostFile: "host.json",
  deviceKey: "device.key",
  runTokenKey: "run-token.key",
  credentials: "credentials.json",
  credentialsKey: "credentials.key",
  socket: "tachod.sock",
  wal: "wal",
  spool: "spool",
  quarantine: "quarantine",
  daemonState: "daemon.json",
  daemonSealedState: "daemon-sealed.json",
  pendingEnds: "pending-session-ends.json",
  hookIdJournal: "hook-ids.jsonl",
  transcriptTailState: "transcript-tail.json",
  stellaMemoryCursors: "stella-memory-cursors.json",
  preSessionCopies: "pre-session",
  stellaIdentity: "stella-identity",
};

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDirFor(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude");
}

/** Codex's home directory: `$CODEX_HOME`, else `~/.codex`. */
export function codexHomeFor(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return env["CODEX_HOME"] ?? join(home, ".codex");
}

/**
 * The Claude Code and Codex directories for `home`, resolved the way
 * `tachoHome` resolves them. The variables describe the running user's own
 * home, so they apply only when `home` is that home: a caller that names
 * another one (a test's scratch directory) gets that home's defaults and
 * never the real directory a variable points at.
 */
export function harnessConfigDirs(
  home: string,
  env: Record<string, string | undefined> = process.env,
  ownHome: string = homedir(),
): { claudeConfigDir: string; codexHome: string } {
  const own = home === ownHome ? env : {};
  return {
    claudeConfigDir: claudeConfigDirFor(own, home),
    codexHome: codexHomeFor(own, home),
  };
}

/** The machine-level paths for `env` and `home`. */
export function tachoHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): TachoHome {
  const tachoDir =
    env["TACHO_HOME"] ?? join(home, ".config", "oxagen", "tacho");
  const claudeConfigDir = claudeConfigDirFor(env, home);
  const codexHome = codexHomeFor(env, home);
  const stellaHome = env["STELLA_HOME"] ?? join(home, ".stella");
  return {
    tachoDir,
    agents: join(tachoDir, "agents"),
    pid: join(tachoDir, "tachod.pid"),
    log: join(tachoDir, "tachod.log"),
    daemonLauncher: join(tachoDir, "tachod.cmd"),
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    codexHooks: join(codexHome, "hooks.json"),
    cursorHooks: cursorHooksPaths(home, platform, env),
    stellaToml: join(stellaHome, "stella.toml"),
    stellaSettingsJson: join(stellaHome, "settings.json"),
    claudeDesktopConfig: claudeDesktopConfigPath(platform, home, env),
  };
}

/** The machine-level half of `paths`, without any agent's files. */
export function homeOf(paths: TachoHome): TachoHome {
  return {
    tachoDir: paths.tachoDir,
    agents: paths.agents,
    pid: paths.pid,
    log: paths.log,
    daemonLauncher: paths.daemonLauncher,
    claudeSettings: paths.claudeSettings,
    claudeProjects: paths.claudeProjects,
    codexHooks: paths.codexHooks,
    cursorHooks: paths.cursorHooks,
    stellaToml: paths.stellaToml,
    stellaSettingsJson: paths.stellaSettingsJson,
    claudeDesktopConfig: paths.claudeDesktopConfig,
  };
}

/** The paths of the agent whose directory is `<tachoDir>/agents/<id>`. */
export function agentPaths(home: TachoHome, id: string): TachoPaths {
  return pathsInDir(home, join(home.agents, id));
}

/**
 * The paths of an agent kept in `dir`. `agentPaths` is the one layout. This
 * also reads the layout from before ADR-203, where the only enrollment sat
 * in the tacho directory itself, until `tachod` moves it (`host/agents.ts`).
 */
export function pathsInDir(home: TachoHome, dir: string): TachoPaths {
  const files = {} as Record<keyof typeof AGENT_FILES, string>;
  for (const key of Object.keys(AGENT_FILES) as (keyof typeof AGENT_FILES)[])
    files[key] = join(dir, AGENT_FILES[key]);
  return { ...homeOf(home), dir, ...files };
}

/** The shared CLI credential store `oxagen login` writes. */
export function oxagenConfigPath(home: string = homedir()): string {
  return join(home, ".config", "oxagen", "config.json");
}
