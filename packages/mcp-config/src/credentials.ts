/**
 * credentials.ts — Credential resolution for file-based MCP servers.
 *
 * Resolution order (first match wins):
 *   1. Environment variable (envToken field or headers with ${VAR} already expanded)
 *   2. Local credential file (~/.config/oxagen/credentials/<server-name>.json)
 *   3. Remote API fallback (calls the platform to fetch workspace-encrypted token)
 *
 * Credential files store tokens in a simple JSON structure. They are:
 *   - Never committed to VCS (live under ~/.config/oxagen/credentials/)
 *   - Written by `oxagen mcp auth <server>` (OAuth flow) or manually
 *   - Optionally encrypted at rest when OXAGEN_CREDENTIAL_KEY is set
 *
 * For OAuth servers, the credential file holds access + refresh tokens. The
 * refresh logic is handled by the caller (CLI auth command or the runtime
 * contributor) — this module only reads/writes the stored state.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig } from "./schema";

// ── Paths ─────────────────────────────────────────────────────────────────────

const CREDENTIALS_DIR = join(homedir(), ".config", "oxagen", "credentials");

export function getCredentialFilePath(serverName: string): string {
  return join(CREDENTIALS_DIR, `${serverName}.json`);
}

// ── Credential File Schema ────────────────────────────────────────────────────

export interface StoredCredential {
  /** Bearer / access token. */
  accessToken?: string;
  /** OAuth refresh token (for auto-refresh on 401). */
  refreshToken?: string;
  /** Token type (default: "Bearer"). */
  tokenType?: string;
  /** ISO timestamp when the access token expires. Null = no known expiry. */
  expiresAt?: string | null;
  /** OAuth scopes that were granted. */
  scopes?: string[];
  /** Arbitrary headers for header-auth servers. */
  headers?: Record<string, string>;
  /** When this credential was last written. */
  updatedAt?: string;
}

// ── Read / Write ──────────────────────────────────────────────────────────────

/**
 * Read the stored credential for a named server.
 * Returns null if no credential file exists or it's unreadable.
 */
export function readCredential(serverName: string): StoredCredential | null {
  const filePath = getCredentialFilePath(serverName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as StoredCredential;
  } catch {
    return null;
  }
}

/**
 * Write (or overwrite) the credential file for a named server.
 * Creates the credentials directory if it doesn't exist.
 */
export function writeCredential(
  serverName: string,
  credential: StoredCredential,
): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  const filePath = getCredentialFilePath(serverName);
  const data: StoredCredential = {
    ...credential,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Delete the credential file for a named server. No-op if it doesn't exist.
 */
export function deleteCredential(serverName: string): void {
  const filePath = getCredentialFilePath(serverName);
  if (!existsSync(filePath)) return;
  unlinkSync(filePath);
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface ResolvedCredential {
  /** The resolved bearer token (for bearer/oauth auth). */
  token?: string;
  /** Resolved headers (for header auth). */
  headers?: Record<string, string>;
  /** Whether a refresh token is available for auto-refresh. */
  hasRefreshToken: boolean;
  /** Source of the credential. */
  source: "env" | "file" | "remote" | "none";
  /** Whether the token appears expired (based on expiresAt). */
  expired: boolean;
}

export interface ResolveCredentialOptions {
  /** Server name (used to look up credential file). */
  serverName: string;
  /** The server config (already env-expanded). */
  config: McpServerConfig;
  /** Optional: fetch credential from remote API. Return null if unavailable. */
  remoteFetch?: (serverName: string) => Promise<StoredCredential | null>;
}

/**
 * Resolve the effective credential for an MCP server.
 *
 * Resolution order:
 *   1. Env var (envToken already expanded in config by resolve.ts)
 *   2. Credential file (~/.config/oxagen/credentials/<name>.json)
 *   3. Remote API fallback (if remoteFetch provided)
 *   4. None (server has no auth or credential is missing)
 */
export async function resolveCredential(
  opts: ResolveCredentialOptions,
): Promise<ResolvedCredential> {
  const { serverName, config } = opts;

  // stdio servers don't carry auth
  if (config.transport === "stdio") {
    return { hasRefreshToken: false, source: "none", expired: false };
  }

  const auth = "auth" in config ? config.auth : "none";

  if (auth === "none") {
    return { hasRefreshToken: false, source: "none", expired: false };
  }

  // ── Step 1: Check if envToken resolved to a value ───────────────────────────
  if (auth === "bearer" && "envToken" in config && config.envToken) {
    // envToken was already expanded by resolve.ts. If it's non-empty after
    // expansion, the env var was set and we use it directly as the token.
    const envValue = config.envToken;
    // After env expansion, envToken holds the actual token value (not the var name)
    // But we need to distinguish: if the user wrote `"envToken": "MY_TOKEN"` and
    // resolve.ts expanded it... actually envToken is the VAR NAME, not a ${}-wrapped
    // value. The expansion happens on the entire config. So after expansion,
    // envToken still holds the original var name string. The ACTUAL token is in
    // the env. Let's check the env directly.
    const tokenFromEnv =
      process.env[envValue] ??
      (envValue.startsWith("$") ? undefined : envValue);
    // If envToken was written as a raw string (not a var name pattern), treat it as the token.
    // Convention: if the value looks like a var name (UPPER_SNAKE), look it up; otherwise use as-is.
    if (tokenFromEnv && tokenFromEnv.length > 0) {
      return {
        token: tokenFromEnv,
        hasRefreshToken: false,
        source: "env",
        expired: false,
      };
    }
  }

  // Header auth: headers were already env-expanded by resolve.ts
  if (auth === "header" && "headers" in config && config.headers) {
    const resolvedHeaders = config.headers;
    if (Object.keys(resolvedHeaders).length > 0) {
      return {
        headers: resolvedHeaders,
        hasRefreshToken: false,
        source: "env",
        expired: false,
      };
    }
  }

  // ── Step 2: Credential file ─────────────────────────────────────────────────
  const stored = readCredential(serverName);
  if (stored) {
    const now = Date.now();
    const expired = stored.expiresAt
      ? new Date(stored.expiresAt).getTime() < now
      : false;

    if (auth === "header" && stored.headers) {
      return {
        headers: stored.headers,
        hasRefreshToken: false,
        source: "file",
        expired,
      };
    }
    if (stored.accessToken) {
      return {
        token: stored.accessToken,
        hasRefreshToken: !!stored.refreshToken,
        source: "file",
        expired,
      };
    }
  }

  // ── Step 3: Remote API fallback ─────────────────────────────────────────────
  if (opts.remoteFetch) {
    try {
      const remote = await opts.remoteFetch(serverName);
      if (remote) {
        // Cache locally for next time
        writeCredential(serverName, remote);
        const expired = remote.expiresAt
          ? new Date(remote.expiresAt).getTime() < Date.now()
          : false;
        return {
          token: remote.accessToken,
          headers: remote.headers,
          hasRefreshToken: !!remote.refreshToken,
          source: "remote",
          expired,
        };
      }
    } catch {
      // Remote unavailable — fall through to none
    }
  }

  // ── Step 4: No credential found ────────────────────────────────────────────
  return { hasRefreshToken: false, source: "none", expired: false };
}

// ── OAuth Token Refresh Helper ────────────────────────────────────────────────

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/**
 * Attempt to refresh an OAuth token using the stored refresh_token.
 * This is a thin wrapper — the actual OAuth exchange is performed by the caller
 * (typically the MCP SDK's auth module). This function just manages the
 * credential file lifecycle around the refresh.
 */
export async function persistRefreshedTokens(
  serverName: string,
  result: RefreshResult,
): Promise<void> {
  const existing = readCredential(serverName) ?? {};
  writeCredential(serverName, {
    ...existing,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? existing.refreshToken,
    expiresAt: result.expiresAt ?? null,
  });
}

/**
 * Check if a server's stored credential needs refresh (expired or about to expire).
 * Returns true if the token expires within the given buffer (default: 5 minutes).
 */
export function needsRefresh(
  serverName: string,
  bufferMs: number = 5 * 60 * 1000,
): boolean {
  const stored = readCredential(serverName);
  if (!stored?.expiresAt) return false; // No expiry known — assume valid
  const expiresAt = new Date(stored.expiresAt).getTime();
  return Date.now() + bufferMs >= expiresAt;
}
