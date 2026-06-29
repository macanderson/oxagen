/**
 * Client-side PKCE (RFC 7636) helpers for the loopback browser login.
 *
 * The verifier/challenge algorithm here MUST match the server's verification
 * in `@oxagen/auth/cli-auth` (`pkceChallengeFromVerifier` / `verifyPkceS256`):
 * the challenge sent to the authorize page is recomputed from the verifier at
 * token-exchange time, so any divergence breaks every login. Both sides use
 * S256: BASE64URL(SHA256(ASCII(code_verifier))). Locked by a shared RFC 7636
 * Appendix B test vector on both sides.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * RFC 7636 §4.1 — a high-entropy code_verifier. base64url(32 bytes) yields 43
 * characters from the unreserved set, the RFC minimum length.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 §4.2 — S256 challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export function codeChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** Opaque CSRF token echoed through the browser round-trip and re-checked. */
export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
