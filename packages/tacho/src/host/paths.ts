/**
 * Where a Tacho host keeps its state (spec section 5.1). Everything lives
 * under one directory so `unenroll` can remove it whole and a test can point
 * `TACHO_HOME` at a scratch directory.
 *
 * The same `~/.config/oxagen` root is used on every platform, Windows
 * included, so `oxagen login` (apps/cli) and the desktop app read one file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeDesktopConfigPath } from "./claude-desktop-writer";
import { cursorHooksPaths } from "./cursor-writer";

export interface TachoPaths {
  /** `~/.config/oxagen/tacho` unless `TACHO_HOME` overrides it. */
  root: string;
  /** Enrollment identity, credentials, cached bundle (0600). */
  hostFile: string;
  /** Ed25519 device private key, PKCS#8 PEM (0600). */
  deviceKey: string;
  /** The HMAC key that signs this host's run tokens (0600; `host/run-token.ts`). */
  runTokenKey: string;
  /** Vendor credentials in the gateway's custody, sealed (`host/credential-store.ts`). */
  credentials: string;
  /** The key that seals `credentials`, in its own file so a copy of one is useless. */
  credentialsKey: string;
  /** The daemon's Unix socket (unused on Windows, where the hook uses TCP). */
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
   * Sealed terminal batches the daemon has not yet landed in the WAL. A batch
   * waits here for the moment between sealing and the WAL append, so the file
   * can hold a run's content and has to be purged with the WAL (ADR-139).
   */
  pendingEnds: string;
  /** Transcript byte cursors, so a restart does not re-read every transcript. */
  transcriptTailState: string;
  /** The daemon's pid file. */
  pid: string;
  /** Daemon stdout/stderr when run as a service. */
  log: string;
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
  /**
   * The wrapper script the Windows scheduled task runs (sets the env, then
   * starts `tachod`). Unused on macOS and Linux, where the unit carries env.
   */
  daemonLauncher: string;
}

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
 * `tachoPaths` resolves them. The variables describe the running user's own
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

export function tachoPaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): TachoPaths {
  const root = env["TACHO_HOME"] ?? join(home, ".config", "oxagen", "tacho");
  const claudeConfigDir = claudeConfigDirFor(env, home);
  const codexHome = codexHomeFor(env, home);
  const stellaHome = env["STELLA_HOME"] ?? join(home, ".stella");
  return {
    root,
    hostFile: join(root, "host.json"),
    deviceKey: join(root, "device.key"),
    runTokenKey: join(root, "run-token.key"),
    credentials: join(root, "credentials.json"),
    credentialsKey: join(root, "credentials.key"),
    socket: join(root, "tachod.sock"),
    wal: join(root, "wal"),
    spool: join(root, "spool"),
    quarantine: join(root, "quarantine"),
    daemonState: join(root, "daemon.json"),
    pendingEnds: join(root, "pending-session-ends.json"),
    transcriptTailState: join(root, "transcript-tail.json"),
    pid: join(root, "tachod.pid"),
    log: join(root, "tachod.log"),
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
    codexHooks: join(codexHome, "hooks.json"),
    cursorHooks: cursorHooksPaths(home, platform, env),
    stellaToml: join(stellaHome, "stella.toml"),
    stellaSettingsJson: join(stellaHome, "settings.json"),
    daemonLauncher: join(root, "tachod.cmd"),
    claudeDesktopConfig: claudeDesktopConfigPath(platform, home, env),
  };
}

/** The shared CLI credential store `oxagen login` writes. */
export function oxagenConfigPath(home: string = homedir()): string {
  return join(home, ".config", "oxagen", "config.json");
}
