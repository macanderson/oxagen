import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

export interface CliConfig {
  token?: string;
  orgSlug?: string;
  workspaceSlug?: string;
  apiUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "oxagen");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as CliConfig;
  } catch {
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
  writeConfig({ token: undefined, orgSlug: undefined, workspaceSlug: undefined });
}

export function getToken(): string | undefined {
  return readConfig().token;
}

export function getApiUrl(): string {
  return process.env["OXAGEN_API_URL"] ?? readConfig().apiUrl ?? "https://oxagen-v2-api.vercel.app";
}
