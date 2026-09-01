import { homedir } from "os";
import { join } from "path";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { atomicWriteFileSync } from "./atomic-write.js";

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
  /** TUI animation level (see getMotionMode) — set via /motion in the REPL. */
  motion?: MotionMode;
  /** Vercel AI Gateway key for the local agent loop (falls back to env / .env.local). */
  gatewayKey?: string;
  /**
   * Anthropic API key — BYOK fallback when no gateway key exists anywhere.
   * Anthropic models only; `gatewayKey` / `AI_GATEWAY_API_KEY` wins when present.
   */
  anthropicKey?: string;
  /** Default verbose mode: capture + emit full per-turn telemetry. */
  verbose?: boolean;
  /** Model-runtime settings */
  runtime?: RuntimeConfig;
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

/**
 * TUI animation level:
 *   - "full"    — everything animates (default).
 *   - "reduced" — no decorative animation: the space-invaders duel / init
 *     easter-egg game and the prompt bar's rainbow border flash are off; the
 *     thinking indicator (useful progress feedback) stays.
 *   - "off"     — all animation off, including the thinking indicator.
 */
export type MotionMode = "full" | "reduced" | "off";

const MOTION_MODES: readonly string[] = ["full", "reduced", "off"];

function asMotionMode(value: string | undefined): MotionMode | undefined {
  return value !== undefined && MOTION_MODES.includes(value)
    ? (value as MotionMode)
    : undefined;
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

/**
 * Resolve the animation level. Env beats persisted config (the convention for
 * every getter here): OXAGEN_CLI_MOTION → the legacy OXAGEN_CLI_FUN=0 opt-out
 * (which predates /motion and disabled exactly the decorative animations,
 * i.e. today's "reduced") → the /motion choice in config → "full".
 */
export function getMotionMode(): MotionMode {
  return (
    asMotionMode(process.env["OXAGEN_CLI_MOTION"]) ??
    (process.env["OXAGEN_CLI_FUN"] === "0" ? "reduced" : undefined) ??
    asMotionMode(readConfig().motion) ??
    "full"
  );
}

/** Persist the animation level chosen with /motion. */
export function setMotionMode(motion: MotionMode): void {
  writeConfig({ motion });
}
