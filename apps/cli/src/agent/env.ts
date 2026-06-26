/**
 * Gateway credential resolution.
 *
 * The local agent loop talks to the Vercel AI Gateway (same gateway the rest of
 * the platform uses — see the `ai-gateway-only` policy). The AI SDK reads
 * `AI_GATEWAY_API_KEY` from the environment automatically, so all we need to do
 * is make sure it is present before the first model call.
 *
 * Resolution order:
 *   1. `AI_GATEWAY_API_KEY` already in the process environment.
 *   2. `gatewayKey` in `~/.config/oxagen/config.json`.
 *   3. The nearest `.env.local` walking up from the current working directory
 *      (so running `oxagen` from inside the monorepo "just works").
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { readConfig } from "../lib/config.js";

const ENV_VAR = "AI_GATEWAY_API_KEY";

function findInEnvLocal(startDir: string): string | undefined {
  let dir = startDir;
  const { root } = parsePath(startDir);
  // Walk up to the filesystem root looking for a .env.local that defines the key.
  for (;;) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, "utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq === -1) continue;
          if (trimmed.slice(0, eq).trim() !== ENV_VAR) continue;
          // Strip surrounding quotes (loadEnv-style over-quoting is common here).
          return trimmed
            .slice(eq + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
        }
      } catch {
        /* unreadable .env.local — keep walking up */
      }
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Ensure `AI_GATEWAY_API_KEY` is set in `process.env`, resolving it from config
 * or a nearby `.env.local` if needed. Returns the key, or `null` if it could
 * not be found anywhere.
 */
export function ensureGatewayKey(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fromConfig = readConfig().gatewayKey;
  if (fromConfig && fromConfig.length > 0) {
    process.env[ENV_VAR] = fromConfig;
    return fromConfig;
  }

  const fromFile = findInEnvLocal(cwd);
  if (fromFile && fromFile.length > 0) {
    process.env[ENV_VAR] = fromFile;
    return fromFile;
  }

  return null;
}
