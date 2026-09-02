/**
 * CLI loopback OAuth (RFC 8252 + PKCE / RFC 7636) — server-side core.
 *
 * The CLI logs in by opening the browser at the app's `/cli/authorize` page,
 * where the (session-authenticated) user approves and picks an org/workspace.
 * The app mints a single-use authorization *code* bound to that scope + the
 * CLI's PKCE challenge, and redirects the browser to the CLI's loopback
 * listener (`http://127.0.0.1:<port>/callback?code=…&state=…`). The CLI then
 * exchanges `code` + its PKCE `code_verifier` at the API for a real API key.
 *
 * This module owns the security-critical primitives shared by the app
 * (authorize → `createCliAuthCode`) and the API (exchange → `consumeCliAuthCode`
 * + `verifyPkceS256`):
 *
 *   - PKCE S256 verification (the only supported method — `plain` is rejected).
 *   - Loopback redirect-URI validation (codes may only ever be sent to
 *     127.0.0.1 / localhost / ::1, never an attacker-controlled host).
 *   - A single-use, short-TTL code store backed by `auth.verifications`
 *     (mirrors packages/plugins/src/oauth/state-store.ts). Redemption is an
 *     atomic delete-returning, so a code cannot be replayed.
 *
 * Threat model (RFC 8252 §8): a malicious local process could observe the
 * loopback redirect and steal the `code`, but cannot exchange it without the
 * `code_verifier` that never leaves the legitimate CLI. `state` guards the
 * callback against CSRF.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

/** verifications.identifier namespace for CLI auth codes. */
const PREFIX = "cli_auth:";

/** Codes are short-lived: the browser→loopback round-trip takes seconds. */
export const CLI_AUTH_CODE_TTL_MS = 5 * 60 * 1000;

/** Only S256 is accepted (RFC 7636 §4.3). `plain` is intentionally unsupported. */
export const CLI_AUTH_PKCE_METHOD = "S256" as const;

/**
 * The scope + PKCE binding carried by an authorization code. Established under
 * the user's authenticated session at authorize time; redeemed (without a
 * session) at exchange time.
 */
export interface CliAuthCodeData {
  /** The approving user. Recorded as the minted key's creator. */
  userId: string;
  /** Resolved org id the CLI key will be scoped to. */
  orgId: string;
  /** Resolved workspace id the CLI key will be scoped to. */
  workspaceId: string;
  /** Slugs echoed back to the CLI so it can store a human-readable session. */
  orgSlug: string;
  workspaceSlug: string;
  /** Base64url SHA-256 of the CLI's PKCE code_verifier. */
  codeChallenge: string;
  /** The exact loopback redirect_uri presented at authorize time. */
  redirectUri: string;
  /** Human label for the minted key (e.g. the CLI host). */
  label: string;
}

/** Cryptographically-random opaque authorization code. */
export function generateCliAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * RFC 7636 §4.6 — recompute the S256 challenge from a verifier:
 * BASE64URL(SHA256(ASCII(code_verifier))). The CLI computes this same value
 * client-side; the API recomputes it here and compares against the stored
 * challenge.
 */
export function pkceChallengeFromVerifier(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * True iff `codeVerifier` corresponds to `codeChallenge` under S256. Constant
 * time in the comparison so a timing side-channel can't reveal the challenge.
 */
export function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  if (
    !isValidCodeVerifier(codeVerifier) ||
    !isValidCodeChallenge(codeChallenge)
  ) {
    return false;
  }
  const expected = Buffer.from(pkceChallengeFromVerifier(codeVerifier), "utf8");
  const provided = Buffer.from(codeChallenge, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** RFC 7636 §4.1 — code_verifier is 43–128 chars of the unreserved set. */
export function isValidCodeVerifier(codeVerifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier);
}

/** A base64url S256 challenge is exactly 43 unpadded base64url chars. */
export function isValidCodeChallenge(codeChallenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(codeChallenge);
}

/**
 * Validate that a redirect_uri is a loopback HTTP URL with an explicit port —
 * the ONLY destination a code may be returned to (RFC 8252 §7.3). Anything
 * else (a non-loopback host, https, a missing port) is rejected so an
 * authorize link can never exfiltrate a code to an attacker-controlled server.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // Loopback native-app redirects are plain http on the local interface.
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  const isLoopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]";
  if (!isLoopback) return false;
  // An explicit ephemeral port is required — the CLI's listener.
  if (!url.port) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  // No credentials, query, or fragment in the registered redirect target.
  if (url.username || url.password || url.search || url.hash) return false;
  return true;
}

/**
 * Persist a single-use authorization code bound to `data`, expiring after
 * CLI_AUTH_CODE_TTL_MS. Stored in auth.verifications under `cli_auth:<code>`,
 * mirroring the MCP OAuth state store.
 */
export async function createCliAuthCode(
  code: string,
  data: CliAuthCodeData,
  now: number,
): Promise<void> {
  const id = PREFIX + code;
  const expiresAt = new Date(now + CLI_AUTH_CODE_TTL_MS);
  await withSystemDb(async (tx) => {
    await tx.insert(schema.verifications).values({
      id,
      identifier: id,
      value: JSON.stringify(data),
      expiresAt,
    });
  });
}

/**
 * Atomically redeem an authorization code. The delete-returning makes
 * redemption single-use: a replayed code finds no row. Returns null when the
 * code is unknown, already redeemed, expired, or its payload is unparseable
 * (never throws for those — the caller surfaces a clean "invalid code").
 */
export async function consumeCliAuthCode(
  code: string,
  now: number,
): Promise<CliAuthCodeData | null> {
  const id = PREFIX + code;
  const row = await withSystemDb(async (tx) => {
    const [deleted] = await tx
      .delete(schema.verifications)
      .where(eq(schema.verifications.id, id))
      .returning({
        value: schema.verifications.value,
        expiresAt: schema.verifications.expiresAt,
      });
    return deleted ?? null;
  });
  if (!row) return null;
  // Expired codes are deleted by the redemption above (good — self-cleaning),
  // but must not be honored.
  if (row.expiresAt.getTime() <= now) return null;
  try {
    return JSON.parse(row.value) as CliAuthCodeData;
  } catch {
    return null;
  }
}
