/**
 * Where a Tacho host keeps its state (spec section 5.1). Everything lives
 * under one directory so `unenroll` can remove it whole and a test can point
 * `TACHO_HOME` at a scratch directory.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface TachoPaths {
  /** `~/.config/oxagen/tacho` unless `TACHO_HOME` overrides it. */
  root: string;
  /** Enrollment identity, credentials, cached bundle (0600). */
  hostFile: string;
  /** Ed25519 device private key, PKCS#8 PEM (0600). */
  deviceKey: string;
  /** The daemon's Unix socket. */
  socket: string;
  /** Per-session append-only event logs and the shipped cursor. */
  wal: string;
  /** Events `tacho-hook` recorded while the daemon was down. */
  spool: string;
  /** Batches the control plane refused, kept for inspection. */
  quarantine: string;
  /** Recorder state the daemon persists so a restart continues each chain. */
  daemonState: string;
  /** The daemon's pid file. */
  pid: string;
  /** Daemon stdout/stderr when run as a service. */
  log: string;
  /** Claude Code's user settings file. */
  claudeSettings: string;
  /** Claude Code's transcript root. */
  claudeProjects: string;
}

export function tachoPaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): TachoPaths {
  const root = env["TACHO_HOME"] ?? join(home, ".config", "oxagen", "tacho");
  const claudeConfigDir = env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude");
  return {
    root,
    hostFile: join(root, "host.json"),
    deviceKey: join(root, "device.key"),
    socket: join(root, "tachod.sock"),
    wal: join(root, "wal"),
    spool: join(root, "spool"),
    quarantine: join(root, "quarantine"),
    daemonState: join(root, "daemon.json"),
    pid: join(root, "tachod.pid"),
    log: join(root, "tachod.log"),
    claudeSettings: join(claudeConfigDir, "settings.json"),
    claudeProjects: join(claudeConfigDir, "projects"),
  };
}

/** The shared CLI credential store `oxagen login` writes. */
export function oxagenConfigPath(home: string = homedir()): string {
  return join(home, ".config", "oxagen", "config.json");
}
