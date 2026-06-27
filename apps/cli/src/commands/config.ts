/**
 * Config command — view or set local CLI configuration.
 *
 * Usage:
 *   oxagen config              Show all config
 *   oxagen config token        Show token (masked)
 *   oxagen config token sk-... Set token
 *   oxagen config model        Show model
 *   oxagen config model gpt-4  Set model
 *   oxagen config api-url      Show API URL
 */
import { readConfig, writeConfig, type CliConfig } from "../lib/config.js";

const VALID_KEYS = ["token", "model", "api-url", "org", "workspace"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

function keyToConfigField(key: ConfigKey): keyof CliConfig {
  switch (key) {
    case "token": return "token";
    case "api-url": return "apiUrl";
    case "org": return "orgSlug";
    case "workspace": return "workspaceSlug";
    case "model": return "model" as keyof CliConfig;
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

export async function handleConfig(key?: string, value?: string): Promise<void> {
  const config = readConfig();

  // No args: show all
  if (!key) {
    console.log("Configuration (~/.config/oxagen/config.json):\n");
    console.log(`  token:     ${config.token ? maskToken(config.token) : "(not set)"}`);
    console.log(`  api-url:   ${config.apiUrl ?? "https://api.oxagen.sh"}`);
    console.log(`  org:       ${config.orgSlug ?? "(not set)"}`);
    console.log(`  workspace: ${config.workspaceSlug ?? "(not set)"}`);
    console.log(`\nSet a value: oxagen config <key> <value>`);
    return;
  }

  if (!VALID_KEYS.includes(key as ConfigKey)) {
    console.error(`Unknown config key: "${key}"`);
    console.error(`Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const field = keyToConfigField(key as ConfigKey);

  // Get
  if (value === undefined) {
    const current = config[field];
    if (!current) {
      console.log(`${key}: (not set)`);
    } else if (key === "token") {
      console.log(`${key}: ${maskToken(current as string)}`);
    } else {
      console.log(`${key}: ${current}`);
    }
    return;
  }

  // Set
  writeConfig({ [field]: value });
  const display = key === "token" ? maskToken(value) : value;
  console.log(`✓ ${key} = ${display}`);
}
