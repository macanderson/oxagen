import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../../.env.local");
  if (!fs.existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const env = loadEnvLocal();

function get(key: string): string {
  return process.env[key] ?? env[key] ?? "";
}

function extractHostFromUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname || "";
  } catch {
    return "";
  }
}

// Shell sessions can carry stale/mangled exports (e.g. a value truncated at
// "#") that would shadow a valid .env.local value, so take the first source
// that is actually a parseable URL instead of the first that is non-empty.
function firstParseableUrl(key: string): string {
  for (const value of [process.env[key], env[key]]) {
    if (!value) continue;
    try {
      new URL(value);
      return value;
    } catch {
      continue;
    }
  }
  return "";
}

// Always extract hostname from ANALYTICS_URL and use HTTPS on 8443
const analyticsUrl = firstParseableUrl("ANALYTICS_URL");
const host = get("OXAGEN_ANALYTICS_HOST") || extractHostFromUrl(analyticsUrl);
const port = get("OXAGEN_ANALYTICS_PORT") || "8443";

export const ANALYTICS_URL = host
  ? `https://${host}:${port}`
  : analyticsUrl || "";
export const ANALYTICS_USER =
  get("ANALYTICS_USER") || get("OXAGEN_ANALYTICS_USER");
export const ANALYTICS_PASSWORD =
  get("ANALYTICS_PASSWORD") || get("OXAGEN_ANALYTICS_PASSWORD");
export const ANALYTICS_DATABASE =
  get("ANALYTICS_DATABASE") || get("OXAGEN_ANALYTICS_DATABASE") || "internal";
