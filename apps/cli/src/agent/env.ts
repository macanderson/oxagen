/**
 * AI credential resolution.
 *
 * The local agent loop talks to the Vercel AI Gateway (same gateway the rest of
 * the platform uses — see the `ai-gateway-only` policy) whenever a gateway key
 * is available: the AI SDK reads `AI_GATEWAY_API_KEY` from the environment
 * automatically, so all we need to do is make sure it is present before the
 * first model call.
 *
 * Fallback: when NO gateway key can be found but an `ANTHROPIC_API_KEY` can,
 * the CLI runs Anthropic models directly against the Anthropic API (see
 * `anthropic-direct.ts`). The gateway key always wins when both are present.
 *
 * Each key resolves in the same order:
 *   1. Already in the process environment.
 *   2. `gatewayKey` / `anthropicKey` in `~/.config/oxagen/config.json`.
 *   3. The nearest `.env.local` walking up from the current working directory
 *      (so running `oxagen` from inside the monorepo "just works").
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { readConfig } from "../lib/config.js";
import { installDirectAnthropicProvider } from "./anthropic-direct.js";

const GATEWAY_ENV_VAR = "AI_GATEWAY_API_KEY";
const ANTHROPIC_ENV_VAR = "ANTHROPIC_API_KEY";

/** Thrown when no AI credential (gateway or Anthropic) can be resolved anywhere. */
export class MissingAiKeyError extends Error {
  constructor() {
    super(
      "No AI credential found. Set AI_GATEWAY_API_KEY (any vendor via the Vercel AI " +
        "Gateway) or ANTHROPIC_API_KEY (Anthropic models only), add one to " +
        '~/.config/oxagen/config.json ("gatewayKey" / "anthropicKey"), or to a ' +
        ".env.local above the working directory.",
    );
    this.name = "MissingAiKeyError";
  }
}

function findInEnvLocal(varName: string, startDir: string): string | undefined {
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
          if (trimmed.slice(0, eq).trim() !== varName) continue;
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

/** Resolve one env var via process.env → config field → nearest .env.local. */
function resolveKey(
  varName: string,
  configValue: string | undefined,
  cwd: string,
): string | null {
  const fromEnv = process.env[varName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (configValue && configValue.length > 0) {
    process.env[varName] = configValue;
    return configValue;
  }

  const fromFile = findInEnvLocal(varName, cwd);
  if (fromFile && fromFile.length > 0) {
    process.env[varName] = fromFile;
    return fromFile;
  }

  return null;
}

/**
 * Ensure `AI_GATEWAY_API_KEY` is set in `process.env`, resolving it from config
 * or a nearby `.env.local` if needed. Returns the key, or `null` if it could
 * not be found anywhere.
 *
 * Gateway-only capabilities (embeddings — Anthropic has no embeddings API)
 * gate on this directly; everything else should use {@link resolveAiCredential}
 * so the `ANTHROPIC_API_KEY` fallback applies.
 */
export function ensureGatewayKey(cwd: string = process.cwd()): string | null {
  return resolveKey(GATEWAY_ENV_VAR, readConfig().gatewayKey, cwd);
}

/**
 * Ensure `ANTHROPIC_API_KEY` is set in `process.env`, resolving it from config
 * or a nearby `.env.local` if needed. Returns the key, or `null`.
 */
export function ensureAnthropicKey(cwd: string = process.cwd()): string | null {
  return resolveKey(ANTHROPIC_ENV_VAR, readConfig().anthropicKey, cwd);
}

/** A resolved AI credential: which auth path model calls will take, and the key. */
export interface AiCredential {
  /**
   * `gateway` — plain gateway slugs resolve via the Vercel AI Gateway (any
   * vendor). `anthropic` — `anthropic/*` slugs resolve directly against the
   * Anthropic API; other vendors are unavailable.
   */
  source: "gateway" | "anthropic";
  key: string;
}

/**
 * Resolve the AI credential for model calls: `AI_GATEWAY_API_KEY` first (always
 * wins when present), `ANTHROPIC_API_KEY` as the fallback. Returns `null` when
 * neither can be found.
 *
 * Resolving the Anthropic fallback installs the direct-Anthropic global
 * provider as a side effect, so every call site that passes a plain string
 * model id to the AI SDK routes to the Anthropic API instead of the gateway.
 */
export function resolveAiCredential(
  cwd: string = process.cwd(),
): AiCredential | null {
  const gatewayKey = ensureGatewayKey(cwd);
  if (gatewayKey) return { source: "gateway", key: gatewayKey };

  const anthropicKey = ensureAnthropicKey(cwd);
  if (anthropicKey) {
    installDirectAnthropicProvider(anthropicKey);
    return { source: "anthropic", key: anthropicKey };
  }

  return null;
}

/**
 * Can this credential run the given gateway slug? The gateway runs any vendor;
 * an Anthropic-only credential runs only `anthropic/*` (or bare, unprefixed)
 * model ids.
 */
export function credentialSupportsModel(
  credential: AiCredential,
  modelId: string,
): boolean {
  if (credential.source === "gateway") return true;
  return modelId.startsWith("anthropic/") || !modelId.includes("/");
}
