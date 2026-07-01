import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

export interface CliConfig {
  token?: string;
  orgSlug?: string;
  workspaceSlug?: string;
  apiUrl?: string;
  /** Web app base URL — where `oxagen login` opens the browser authorize page. */
  appUrl?: string;
  model?: string;
  /** Default reasoning effort for models that support it (low|medium|high|xhigh|max). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Vercel AI Gateway key for the local agent loop (falls back to env / .env.local). */
  gatewayKey?: string;
  /** Default verbose mode: capture + emit full per-turn telemetry. */
  verbose?: boolean;
  /** Model-runtime settings (Group 1: on-device runtime + coordinator choice). */
  runtime?: RuntimeConfig;
  /**
   * Pipeline / assist-tool settings (Group 4: prompt enhancer, judge, survey).
   * A partial override layered over the defaults; read through the typed
   * accessors in `pipeline/config.ts`, not the flat `oxagen config` command.
   */
  pipeline?: import("../pipeline/config.js").AssistPipelineConfigPatch;
  /**
   * Background-monitor settings (Group 5: ask-before-monitoring, dispatch
   * triggers, poll cadence). A partial override layered over the defaults;
   * read through the typed accessors in `monitors/config.ts`.
   */
  monitors?: import("../monitors/config.js").MonitorsConfigPatch;
}

/**
 * Model-runtime config. Nested under `runtime` in the config file. Every field
 * is optional; unset fields fall back to the baked-in defaults in
 * `runtime/models.json`. Read/written through typed accessors in
 * `runtime/config.ts` (not the flat `oxagen config` command).
 */
export interface RuntimeConfig {
  /** Which model coordinates the agent: "on-device" or a cloud id like "haiku". */
  coordinator?: string;
  onDevice?: {
    /** Auto-download the resolved model on first on-device coordinator use. */
    autoDownload?: boolean;
    /** "auto" (resolve best for device) or a pinned capability-table modelId. */
    modelId?: string;
    /** Override the weights cache directory (defaults to ~/.oxagen/models). */
    cacheDir?: string;
    /** Verify downloads against a checksum before caching. */
    verifyChecksum?: boolean;
    /** Quantization preference, best quality first (e.g. ["q8","q6","q5","q4"]). */
    quantizationPreference?: ("q4" | "q5" | "q6" | "q8")[];
  };
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

export function getAppUrl(): string {
  return (
    process.env["OXAGEN_APP_URL"] ??
    readConfig().appUrl ??
    "https://app.oxagen.sh"
  );
}
