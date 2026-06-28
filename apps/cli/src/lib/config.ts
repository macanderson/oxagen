import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

export interface CliConfig {
  token?: string;
  orgSlug?: string;
  workspaceSlug?: string;
  apiUrl?: string;
  model?: string;
  /** Vercel AI Gateway key for the local agent loop (falls back to env / .env.local). */
  gatewayKey?: string;
  /** Default verbose mode: capture + emit full per-turn telemetry. */
  verbose?: boolean;
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
        `Run \`oxagen auth login\` to re-authenticate.\n`,
    );
    return {};
  }
}

export function writeConfig(patch: Partial<CliConfig>): void {
  const current = readConfig();
  const next = { ...current, ...patch };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
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
