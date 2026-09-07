import { homedir } from "os";
import { join } from "path";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { atomicWriteFileSync } from "./atomic-write.js";

/**
 * The CLI's credential store, at `~/.config/oxagen/config.json`.
 *
 * It holds exactly the platform session (`oxagen login` writes it, `oxagen
 * logout` clears it) plus the anonymous-telemetry preferences. The model keys,
 * default model/effort, and TUI settings this file used to carry belonged to
 * the local coding agent and went with it (ADR-041) — the CLI makes no LLM
 * calls of its own, so there is no provider key to store.
 */
export interface CliConfig {
  token?: string;
  orgSlug?: string;
  workspaceSlug?: string;
  apiUrl?: string;
  /** Web app base URL — where `oxagen login` opens the browser authorize page. */
  appUrl?: string;
  /** Anonymous usage-telemetry preferences (apps/cli/src/telemetry/usage.ts). */
  telemetry?: TelemetryConfig;
}

/**
 * Anonymous CLI usage-telemetry preferences, persisted alongside the rest of
 * `CliConfig`. See TELEMETRY.md at the repo root for the full disclosure —
 * telemetry is ON by default (opt-out), so this section is absent until the
 * first run (which sets `disclosed` + `installId`) or the user runs
 * `oxagen telemetry off/on`.
 */
export interface TelemetryConfig {
  /** false = fully disabled (no id generation, no network). Absent/true = enabled. */
  enabled?: boolean;
  /** True once the one-time first-run disclosure has been printed. */
  disclosed?: boolean;
  /** Random per-install id (crypto.randomUUID()), generated on first enabled run. */
  installId?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "oxagen");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as CliConfig;
  } catch (err) {
    // existsSync confirmed the file exists; reaching here means the file could
    // not be read (permissions, I/O error) or contains invalid JSON (truncated
    // write, corruption). Emit a clear warning so the user understands why all
    // credentials appear missing, rather than silently returning empty config.
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: failed to read config file ${CONFIG_FILE}: ${detail}\n` +
        `Run \`oxagen login\` to re-authenticate.\n`,
    );
    return {};
  }
}

export function writeConfig(patch: Partial<CliConfig>): void {
  const current = readConfig();
  const next = { ...current, ...patch };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  // Atomic (write temp + rename) — a plain writeFileSync truncates the file
  // before the new bytes land, so a kill mid-write (or a second parallel CLI
  // session writing the same config.json) can strand a corrupt/empty file
  // (see item 9, fix/cli-config-truth).
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

export function clearConfig(): void {
  writeConfig({
    token: undefined,
    orgSlug: undefined,
    workspaceSlug: undefined,
  });
}

export function getToken(): string | undefined {
  return process.env["OXAGEN_API_TOKEN"] ?? readConfig().token;
}

export function getOrgId(): string | undefined {
  return process.env["OXAGEN_ORG_ID"] ?? readConfig().orgSlug;
}

export function getWorkspaceId(): string | undefined {
  return process.env["OXAGEN_WORKSPACE_ID"] ?? readConfig().workspaceSlug;
}

export function getApiUrl(): string {
  return (
    process.env["OXAGEN_API_URL"] ??
    readConfig().apiUrl ??
    "https://api.oxagen.sh"
  );
}

export function getAppUrl(): string {
  return (
    process.env["OXAGEN_APP_URL"] ??
    readConfig().appUrl ??
    "https://app.oxagen.sh"
  );
}

